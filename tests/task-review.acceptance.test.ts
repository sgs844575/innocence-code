// P1 bootstrap acceptance (Task 14, brief step 1 + step 2): the BASELINE task
// closed loop over the REAL stack — packages/task-cli's createTaskCliRuntime
// composes the real task-workspace repository (CAS + locks + scanner), the
// real task-git adapter and plugin-task's attribution fold; Git fixtures are
// real temporary repositories and every assertion reads bytes back from disk.
//
// The fixture (brief step 1) contains every dirty-worktree shape the loop
// must preserve byte-for-byte: tracked-but-uncommitted modifications, an
// untracked file, a NON-EMPTY Git index (staged change), agent multi-file
// modifications producing >= 2 hunks in one file, and an external concurrent
// modification that arrives mid-task.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openTaskRepository, sha256Bytes } from "@innocencecode/task-workspace";
import type { Checkpoint, TaskEvent } from "@innocencecode/task-core";
import { collectStructuredOutput, createTaskCliAdapter, createTaskCliRuntime } from "@innocencecode/task-cli";

const execFileAsync = promisify(execFile);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 75 * 2 ** attempt));
      }
    }
  });
  return dir;
}

async function gitExec(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

const APP_PRE_TASK = [
  "line1", "line2", "line3", "line4", "line5",
  "line6", "line7", "line8", "",
].join("\n");

/** The agent's version of app.txt: two insertions far apart → TWO hunks. */
function appAfterAgent(): string {
  return [
    "line1", "line2", "agent insertion A", "line3", "line4", "line5",
    "line6", "agent insertion B", "line7", "line8", "",
  ].join("\n");
}

/**
 * Real temporary Git repository with the brief-step-1 fixture:
 * committed base + tracked-uncommitted edit + untracked file + staged change.
 */
async function createDirtyFixture(): Promise<string> {
  const root = await tempDir("ic-accept-review-");
  await gitExec(root, ["init", "-b", "main"]);
  await gitExec(root, ["config", "user.name", "Acceptance Fixture"]);
  await gitExec(root, ["config", "user.email", "acceptance@example.invalid"]);
  await gitExec(root, ["config", "core.autocrlf", "false"]);
  const committed: Record<string, string> = {
    "src/app.txt": APP_PRE_TASK,
    "keep.txt": "untouched pre-task content\n",
    "staged.txt": "original\n",
    "dirty.txt": "original\n",
  };
  for (const [name, content] of Object.entries(committed)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  await gitExec(root, ["add", "-A"]);
  await gitExec(root, ["commit", "-m", "fixture base"]);
  // tracked but uncommitted (unstaged) modification
  await fs.writeFile(path.join(root, "dirty.txt"), "original\nuncommitted\n", "utf8");
  // NON-EMPTY index: a staged change that must survive byte-for-byte
  await fs.writeFile(path.join(root, "staged.txt"), "original\nstaged change\n", "utf8");
  await gitExec(root, ["add", "staged.txt"]);
  // untracked file
  await fs.mkdir(path.join(root, "notes"), { recursive: true });
  await fs.writeFile(path.join(root, "notes", "scratch.md"), "scratch\n", "utf8");
  return root;
}

/** Byte map of every file under a root (excluding .git), for byte-identity checks. */
async function byteSnapshot(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = path.join(dir, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      files.set(relative, await fs.readFile(absolute));
    }
  }
  await walk(root, "");
  return files;
}

function expectSnapshotsIdentical(before: Map<string, Buffer>, after: Map<string, Buffer>, context: string): void {
  const unexpected = [...after.keys()].filter((key) => !before.has(key));
  const missing = [...before.keys()].filter((key) => !after.has(key));
  expect(`added: ${unexpected.join(",")}; removed: ${missing.join(",")}`, context).toBe("added: ; removed: ");
  for (const [key, bytes] of before) {
    expect(Buffer.from(after.get(key)!).equals(bytes), `${context}: ${key} must be byte-identical`).toBe(true);
  }
}

/**
 * Byte snapshots of the files the task loop must NEVER touch. Excluded:
 * src/app.txt (the agent's target, asserted separately), agent-new.txt (the
 * agent's own new file) and notes/scratch.md (the external actor's file — its
 * preservation is asserted against the external bytes directly).
 */
async function preservedSnapshot(root: string): Promise<Map<string, Buffer>> {
  const excluded = new Set(["src/app.txt", "agent-new.txt", "notes/scratch.md"]);
  const all = await byteSnapshot(root);
  return new Map([...all].filter(([key]) => !excluded.has(key)));
}

async function stagedDiff(root: string): Promise<string> {
  return gitExec(root, ["diff", "--cached"]);
}

async function fileText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Appends a raw attributionPending event the capture middleware would emit. */
async function appendAttributionPending(storageDir: string, taskId: string, paths: string[]): Promise<void> {
  const repository = await openTaskRepository(storageDir, taskId);
  await repository.append([{ type: "attributionPending", paths } as TaskEvent]);
}

describe("task review acceptance: baseline closed loop over a dirty worktree", () => {
  it("preserves pre-task files, untracked files and the staged index through accept/restore/complete", async () => {
    const repo = await createDirtyFixture();
    const storageDir = await tempDir("ic-accept-store-");

    // -- the byte-identical baseline every assertion compares against --------
    const preTaskFiles = await preservedSnapshot(repo);
    const preTaskStagedDiff = await stagedDiff(repo);
    const preTaskIndex = await gitExec(repo, ["ls-files", "-s"]);
    expect(preTaskStagedDiff).toContain("staged change"); // the index is really non-empty

    let agentRan = false;
    const runtime = await createTaskCliRuntime({
      storageDir,
      agentWriter: async (task) => {
        agentRan = true;
        // Agent multi-file modification: two hunks in src/app.txt + a new file.
        await fs.writeFile(path.join(task.workspaceRoot, "src", "app.txt"), appAfterAgent(), "utf8");
        await fs.writeFile(path.join(task.workspaceRoot, "agent-new.txt"), "generated by the agent\n", "utf8");
      },
    });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });

    // create → the checkpoint captures the dirty pre-task state (review basis
    // is the checkpoint, NOT the Git index)
    const task = await cli.start({ workspaceRoot: repo, mode: "baseline" });
    expect(agentRan).toBe(true);
    const checkpoint = await cli.getCheckpoint(task.taskId, task.baselineCheckpointId);
    expect(checkpoint).not.toBeNull();
    const checkpointHashes = new Map((checkpoint as Checkpoint).files.map((file) => [file.path, file.hash]));
    const preTaskAppHash = sha256Bytes(new TextEncoder().encode(APP_PRE_TASK));
    expect(checkpointHashes.get("src/app.txt")).toBe(preTaskAppHash);
    expect(checkpointHashes.get("dirty.txt")).toBe(sha256Bytes(new TextEncoder().encode("original\nuncommitted\n")));
    expect(checkpointHashes.get("notes/scratch.md")).toBe(sha256Bytes(new TextEncoder().encode("scratch\n")));
    expect(checkpointHashes.has("staged.txt")).toBe(true);

    // external concurrent modification arrives mid-task (before review)
    await fs.writeFile(path.join(repo, "notes", "scratch.md"), "scratch\nexternally edited\n", "utf8");
    await appendAttributionPending(storageDir, task.taskId, ["notes/scratch.md"]);

    // -- the review set is checkpoint-vs-workspace: the pre-task dirty and
    // staged files produce NO hunks; only agent + external changes appear ----
    let hunks = await cli.listHunks(task.taskId, task.activeRouteId);
    const appHunks = hunks.filter((hunk) => hunk.path === "src/app.txt");
    expect(appHunks.length).toBeGreaterThanOrEqual(2); // brief: >= 2 hunks
    expect([...new Set(hunks.map((hunk) => hunk.path))].sort()).toEqual([
      "agent-new.txt",
      "notes/scratch.md",
      "src/app.txt",
    ]);
    // the pending external change shows as a conflict and blocks completion
    expect(hunks.find((hunk) => hunk.path === "notes/scratch.md")?.status).toBe("conflict");
    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: false }))
      .rejects.toMatchObject({ code: "completion-gate" });

    // attribute the external change (external → excluded, protected content)
    await cli.attributeUnknown(task.taskId, "notes/scratch.md", "external");
    hunks = await cli.listHunks(task.taskId, task.activeRouteId);
    expect(hunks.find((hunk) => hunk.path === "notes/scratch.md")?.status).not.toBe("conflict");

    // -- hunk accept: accept() NEVER touches files ---------------------------
    await cli.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: appHunks[0]!.ref, status: "accepted" });
    expect(await fileText(path.join(repo, "src", "app.txt"))).toBe(appAfterAgent());
    await cli.review({
      taskId: task.taskId, routeId: task.activeRouteId,
      hunkRef: hunks.find((hunk) => hunk.path === "agent-new.txt")!.ref, status: "accepted",
    });
    await cli.review({
      taskId: task.taskId, routeId: task.activeRouteId,
      hunkRef: hunks.find((hunk) => hunk.path === "notes/scratch.md")!.ref, status: "accepted",
    });

    // -- hunk restore: rejects a stale expectedVersion, then reverts with CAS
    await expect(
      cli.restore({
        taskId: task.taskId, routeId: task.activeRouteId,
        hunkRef: appHunks[1]!.ref, expectedVersion: "v0:stale",
      }),
    ).rejects.toMatchObject({ code: "version-conflict" });
    expect(await fileText(path.join(repo, "src", "app.txt"))).toBe(appAfterAgent()); // untouched by the refusal
    const version = (await cli.getTask(task.taskId)).version ?? "";
    await cli.restore({
      taskId: task.taskId, routeId: task.activeRouteId,
      hunkRef: appHunks[1]!.ref, expectedVersion: version,
    });
    // restore reverts src/app.txt to its pre-task bytes (file-level restore)
    expect(await fileText(path.join(repo, "src", "app.txt"))).toBe(APP_PRE_TASK);

    // mid-loop invariants: preserved files + staged index byte-identical
    expectSnapshotsIdentical(preTaskFiles, await preservedSnapshot(repo), "after accept/restore");
    expect(await stagedDiff(repo)).toBe(preTaskStagedDiff);

    // -- complete: every hunk is accepted or restored ------------------------
    expect(await cli.getTask(task.taskId)).toMatchObject({ unreviewedChanges: 0 });
    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: false })).resolves.toBeUndefined();

    // -- final byte-identical assertions -------------------------------------
    const finalFiles = await byteSnapshot(repo);
    expect(Buffer.from(finalFiles.get("src/app.txt")!).toString("utf8")).toBe(APP_PRE_TASK); // restored
    expect(Buffer.from(finalFiles.get("agent-new.txt")!).toString("utf8")).toBe("generated by the agent\n");
    expect(Buffer.from(finalFiles.get("notes/scratch.md")!).toString("utf8")).toBe("scratch\nexternally edited\n");
    expectSnapshotsIdentical(preTaskFiles, await preservedSnapshot(repo), "after complete");
    expect(await stagedDiff(repo)).toBe(preTaskStagedDiff);
    // the index itself (modes + blobs) never moved
    expect(await gitExec(repo, ["ls-files", "-s"])).toBe(preTaskIndex);
    // untracked pre-task file survives as untracked
    expect((await gitExec(repo, ["status", "--porcelain"])).split("\n")).toEqual(
      expect.arrayContaining(["?? agent-new.txt", "?? notes/"]),
    );
  }, 120_000);
});
