// C1 (final review): a production path creates a task. task:start
// (TaskIpcHandlers.start -> TaskCommandService.startTask) find-or-starts the
// session's task over REAL storage and a REAL git fixture, binds the
// session's sends to the task route (the onSessionTaskRoute port the host
// feeds into harnessGlue's session->route map), and re-finds the task after a
// restart (fresh bridge over the same storage recovers it live).
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskRuntimeBridge } from "./taskRuntimeBridge";
import { createTaskCommandService } from "./taskCommandService";

const execFileAsync = promisify(execFile);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return dir;
}

async function createGitFixture(): Promise<string> {
  const root = await tempDir("ic-task-start-git-");
  const git = (args: string[]) => execFileAsync("git", args, { cwd: root, windowsHide: true });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Start Fixture"]);
  await git(["config", "user.email", "start@example.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(root, "a.txt"), "committed\n", "utf8");
  await git(["add", "-A"]);
  await git(["commit", "-m", "fixture base"]);
  return root;
}

describe("task:start (C1)", () => {
  it("find-or-starts the session's task, binds the session route, and refinds it after a restart", async () => {
    const repo = await createGitFixture();
    const storageDir = await tempDir("ic-task-start-store-");
    const bindings: Array<{ sessionId: string; taskId: string; routeId: string }> = [];
    const bridge = createTaskRuntimeBridge({ taskStorageDir: storageDir });
    cleanups.push(() => bridge.disposeAll());
    const service = createTaskCommandService({
      bridge,
      taskStorageDir: storageDir,
      resolveSessionRoot: async (sessionId) => (sessionId === "s1" ? repo : undefined),
      onSessionTaskRoute: (sessionId, taskId, routeId) => bindings.push({ sessionId, taskId, routeId }),
      onEvent: () => {},
    });

    // create:true starts the session's task on the resolved workspace root.
    const started = await service.startTask({ sessionId: "s1", mode: "baseline", create: true });
    expect(started).toMatchObject({ sessionId: "s1", routeId: "main", mode: "baseline" });
    expect(bridge.listTasks()).toEqual([started!.taskId]);
    expect(bindings).toEqual([{ sessionId: "s1", taskId: started!.taskId, routeId: "main" }]);

    // create:false finds the SAME task instead of starting a second one.
    const found = await service.startTask({ sessionId: "s1", create: false });
    expect(found?.taskId).toBe(started!.taskId);
    expect(bridge.listTasks()).toHaveLength(1);

    // Unknown session probes resolve null without creating anything.
    expect(await service.startTask({ sessionId: "nope", create: false })).toBeNull();
    expect(bridge.listTasks()).toHaveLength(1);

    // A session without a workspace root cannot start (fail closed).
    await expect(service.startTask({ sessionId: "s2", create: true })).rejects.toThrow(
      "no workspace root",
    );

    // Restart: a FRESH bridge over the same storage finds the persisted task
    // and recovers it live (subsequent sends re-enter the P1 loop).
    const bridge2 = createTaskRuntimeBridge({ taskStorageDir: storageDir });
    cleanups.push(() => bridge2.disposeAll());
    const bindings2: Array<{ sessionId: string; taskId: string; routeId: string }> = [];
    const service2 = createTaskCommandService({
      bridge: bridge2,
      taskStorageDir: storageDir,
      resolveSessionRoot: async () => repo,
      onSessionTaskRoute: (sessionId, taskId, routeId) => bindings2.push({ sessionId, taskId, routeId }),
      onEvent: () => {},
    });
    const recovered = await service2.startTask({ sessionId: "s1", create: false });
    expect(recovered?.taskId).toBe(started!.taskId);
    expect(bridge2.listTasks()).toEqual([started!.taskId]);
    expect(bindings2).toEqual([{ sessionId: "s1", taskId: started!.taskId, routeId: "main" }]);
  }, 120_000);
});
