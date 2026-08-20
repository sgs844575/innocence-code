import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { openPrivateTaskStorage, taskRootPath, assertSafeTaskId } from "../src/private-task-storage.ts";
import { openTaskRepository } from "../src/task-repository.ts";
import { createTaskHead, taskCreatedEvent, turnCheckpointedEvent } from "@innocencecode/task-core";

const exec = promisify(execFile);

let base: string;

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-tws-privstorage-"));
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("private task storage layout", () => {
  it("creates the fixed layout under <base>/tasks/<taskId>", async () => {
    const storage = await openPrivateTaskStorage(base, "task_layout1");
    expect(storage.taskRoot).toBe(path.join(base, "tasks", "task_layout1"));
    for (const dir of ["objects", "checkpoints", "events", "backup", "temp", "apply-journal"]) {
      expect((await fs.stat(path.join(storage.taskRoot, dir))).isDirectory()).toBe(true);
    }
    expect(storage.eventsPath).toBe(path.join(storage.taskRoot, "events.jsonl"));
    expect(storage.taskHeadPath).toBe(path.join(storage.taskRoot, "task.json"));
    expect((await fs.stat(path.join(base, "locks", "workspace"))).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(base, "locks", "task"))).isDirectory()).toBe(true);
  });

  it("rejects task ids that could escape the tasks directory", async () => {
    for (const bad of ["a/b", "..", "", "a\\b", "task id", "-leading", ".hidden"]) {
      expect(() => assertSafeTaskId(bad)).toThrow();
      await expect(openPrivateTaskStorage(base, bad)).rejects.toThrow();
    }
    expect(taskRootPath(base, "task_ok")).toBe(path.join(base, "tasks", "task_ok"));
  });

  it("keeps events.jsonl and task.json inside the task root via storage paths", async () => {
    const storage = await openPrivateTaskStorage(base, "task_paths");
    await storage.storage.writeFile("events.jsonl", "{}\n");
    await storage.storage.writeFileAtomic("task.json", "{}\n");
    expect((await fs.stat(path.join(storage.taskRoot, "events.jsonl"))).isFile()).toBe(true);
    expect((await fs.stat(path.join(storage.taskRoot, "task.json"))).isFile()).toBe(true);
  });

  it.runIf(process.platform === "win32")("restricts the task root to the current user (icacls)", async () => {
    const storage = await openPrivateTaskStorage(base, "task_acl");
    const [{ stdout: whoamiOut }, { stdout: acl }] = await Promise.all([
      exec("whoami"),
      exec("icacls", [storage.taskRoot]),
    ]);
    expect(acl.toLowerCase()).toContain(whoamiOut.trim().toLowerCase());
    expect(acl.toLowerCase()).not.toContain("everyone");
    expect(acl.toLowerCase()).not.toContain("builtin\\");
  });

  it("uses 0700 directories on POSIX hosts", async () => {
    if (process.platform === "win32") {
      return;
    }
    const storage = await openPrivateTaskStorage(base, "task_modes");
    const stat = await fs.stat(storage.taskRoot);
    expect(stat.mode & 0o777).toBe(0o700);
  });
});

describe("task repository over the private layout", () => {
  it("writes/reads the task head atomically and appends/lists events", async () => {
    const repository = await openTaskRepository(base, "task_repo1");
    expect(await repository.readTaskHead()).toBeNull();

    const created = taskCreatedEvent({
      taskId: "task_repo1",
      sessionId: "session_1",
      routeId: "route_1",
      baselineCheckpointId: "cp_base",
    });
    const head = createTaskHead({
      taskId: "task_repo1",
      sessionId: "session_1",
      workspaceRoot: "D:/somewhere",
      workspaceKind: "snapshot",
      mode: "baseline",
      activeRouteId: "route_1",
    });
    await repository.writeTaskHead(head);
    expect(await repository.readTaskHead()).toEqual(head);

    await repository.append([created]);
    const checkpointEvent = turnCheckpointedEvent({
      checkpointId: "cp_base",
      turnId: "turn_1",
      files: [{ path: "a.txt", exists: true, hash: "a".repeat(64), mode: 0o644, binary: false }],
    });
    await repository.append([checkpointEvent]);
    const events = await repository.list();
    expect(events.map((event) => event.type)).toEqual(["taskCreated", "turnCheckpointed"]);
    expect(events[1]).toEqual(checkpointEvent);

    // events.jsonl lives at the fixed path
    expect((await fs.stat(path.join(base, "tasks", "task_repo1", "events.jsonl"))).isFile()).toBe(true);
  });

  it("stores objects and checkpoints through the same secure storage", async () => {
    const repository = await openTaskRepository(base, "task_repo2");
    const { key } = await repository.objects.put(new TextEncoder().encode("payload"));
    expect(await repository.objects.has(key)).toBe(true);
    expect((await fs.stat(path.join(base, "tasks", "task_repo2", "objects", key))).isFile()).toBe(true);

    await repository.writeCheckpoint({
      checkpointId: "cp_x",
      taskId: "task_repo2",
      routeId: "route_1",
      turnId: "turn_1",
      files: [],
    });
    expect((await repository.readCheckpoint("cp_x"))!.checkpointId).toBe("cp_x");
    expect((await fs.stat(path.join(base, "tasks", "task_repo2", "checkpoints", "cp_x.json"))).isFile()).toBe(true);
  });

  it("surfaces a corrupt events line instead of silently dropping it", async () => {
    const repository = await openTaskRepository(base, "task_repo3");
    await repository.append([taskCreatedEvent({ taskId: "task_repo3" })]);
    await repository.storage.storage.appendFile("events.jsonl", "{not-json}\n");
    await expect(repository.list()).rejects.toThrow(/corrupt events\.jsonl/);
  });
});
