// taskRuntimeBridge integration: real Git fixtures + real task-workspace
// storage against temp dirs, no Electron window surface (the bridge module
// is electron-free; the host glue owns its instance). Covers the P1 bridge
// contract: isolated start (worktree + baseline overlay), worktree failure
// (NO baseline fallback), snapshot workspaces, lock order, capture windows,
// the single event log incl. plugin events, and release semantics.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createExecutionScope } from "@innocencecode/harness-core";
import { createGitAdapter, type GitAdapter, type GitWorkspaceInfo } from "@innocencecode/task-git";
import type { TaskEvent, TaskScope } from "@innocencecode/plugin-task";
import {
  reduceTask,
  turnCommittedEvent,
  turnPreparedEvent,
  turnCheckpointedEvent,
  type Checkpoint,
} from "@innocencecode/task-core";
import { openTaskRepository, sha256Bytes } from "@innocencecode/task-workspace";
import {
  createTaskRuntimeBridge,
  resolveTaskWorkspaceRoot,
  type TaskEventNotification,
  type TaskRuntimeBridge,
} from "./taskRuntimeBridge";

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

/** Real temporary Git repository (committed base + optional untracked files). */
async function createGitFixture(files: Record<string, string>): Promise<string> {
  const root = await tempDir("ic-bridge-git-");
  await gitExec(root, ["init", "-b", "main"]);
  await gitExec(root, ["config", "user.name", "Bridge Fixture"]);
  await gitExec(root, ["config", "user.email", "bridge@example.invalid"]);
  await gitExec(root, ["config", "core.autocrlf", "false"]);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  await gitExec(root, ["add", "-A"]);
  await gitExec(root, ["commit", "-m", "fixture base"]);
  return root;
}

async function worktreePaths(repoRoot: string): Promise<string[]> {
  const porcelain = await gitExec(repoRoot, ["worktree", "list", "--porcelain"]);
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}

interface BridgeHarness {
  bridge: TaskRuntimeBridge;
  storageDir: string;
  events: TaskEventNotification[];
}

/** Bridge with a temp storage dir and a recording event listener. */
async function makeBridge(git?: GitAdapter): Promise<BridgeHarness> {
  const storageDir = await tempDir("ic-bridge-store-");
  const events: TaskEventNotification[] = [];
  const bridge = createTaskRuntimeBridge({
    taskStorageDir: storageDir,
    git,
    onTaskEvent: (notification) => events.push(notification),
  });
  return { bridge, storageDir, events };
}

const taskScopeOf = (taskId: string, routeId = "main"): TaskScope => ({
  ...createExecutionScope("BridgeTest"),
  taskId,
  routeId,
});

async function fileText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

describe("taskRuntimeBridge.start", () => {
  it("isolated start creates a worktree and overlays the baseline before any agent run", async () => {
    const repo = await createGitFixture({ "a.txt": "committed content\n" });
    await fs.writeFile(path.join(repo, "u.txt"), "uncommitted work\n", "utf8");
    const { bridge, storageDir, events } = await makeBridge();

    const handle = await bridge.start({ mode: "isolated", workspaceRoot: repo, sessionId: "sess-1" });

    expect(handle.workspaceKind).toBe("git");
    expect(handle.mode).toBe("isolated");
    expect(handle.workspaceRoot).not.toBe(repo); // the agent runs IN the worktree
    expect(handle.userWorkspaceRoot).toBe(repo);
    // The worktree is registered and carries the committed AND uncommitted baseline.
    const registered = await worktreePaths(repo);
    expect(await Promise.all(registered.map((p) => samePath(p, handle.workspaceRoot)))).toContain(true);
    expect(await fileText(path.join(handle.workspaceRoot, "a.txt"))).toBe("committed content\n");
    expect(await fileText(path.join(handle.workspaceRoot, "u.txt"))).toBe("uncommitted work\n");
    // The baseline is durable before any agent run: taskCreated (git kind,
    // effective root) + baseline checkpoint + task head are on disk.
    const taskDir = path.join(storageDir, "tasks", handle.taskId);
    expect((await fileText(path.join(taskDir, "task.json"))) ?? "").toContain(`"workspaceKind": "git"`);
    await expect(
      fs.access(path.join(taskDir, "checkpoints", `${handle.baselineCheckpointId}.json`)),
    ).resolves.toBeUndefined();
    const log = await bridge.listEvents(handle.taskId);
    expect(log.map((event) => event.type)).toEqual(["taskCreated"]);
    expect(events.map((n) => n.event.type)).toEqual(["taskCreated"]);

    await bridge.disposeAll();
  });

  it("does not fall back to baseline when worktree creation fails", async () => {
    const repo = await createGitFixture({ "a.txt": "x\n" });
    const failingGit: GitAdapter = {
      ...createGitAdapter(),
      async detect(root: string): Promise<GitWorkspaceInfo> {
        return createGitAdapter().detect(root); // real detection: this IS a repo
      },
      createWorktree: async () => {
        throw new Error("cannot create worktree: destination is locked");
      },
    };
    const { bridge, storageDir } = await makeBridge(failingGit);

    await expect(bridge.start({ mode: "isolated", workspaceRoot: repo })).rejects.toThrow("worktree");

    // No baseline fallback: nothing was registered or recorded as a task
    // (an empty private-storage scaffold is fine — no events were logged).
    expect(bridge.listTasks()).toEqual([]);
    const tasksDir = path.join(storageDir, "tasks");
    const persisted = await fs.readdir(tasksDir).catch(() => [] as string[]);
    for (const entry of persisted) {
      const events = path.join(tasksDir, entry, "events.jsonl");
      expect(await fileText(events)).toBeNull();
    }
    await bridge.disposeAll();
  });

  it("destroys the worktree when the baseline overlay fails mid-start (no orphan)", async () => {
    const repo = await createGitFixture({ "a.txt": "x\n" });
    const storageDir = await tempDir("ic-bridge-overlay-");
    const worktreeDir = path.join(storageDir, "wt");
    const failingOverlay: GitAdapter = {
      ...createGitAdapter(),
      overlayBaseline: async () => {
        throw new Error("overlay boom");
      },
    };
    const bridge = createTaskRuntimeBridge({
      taskStorageDir: storageDir,
      worktreeDir,
      git: failingOverlay,
      onTaskEvent: () => {},
    });

    await expect(
      bridge.start({ taskId: "task_overlay", mode: "isolated", workspaceRoot: repo }),
    ).rejects.toThrow("overlay");

    // The attempt's worktree is gone — directory AND Git registration.
    await expect(fs.access(path.join(worktreeDir, "task_overlay"))).rejects.toThrow();
    expect(await worktreePaths(repo)).toHaveLength(1);
    expect(bridge.listTasks()).toEqual([]);
    await bridge.disposeAll();
  });

  it("baseline mode runs directly in the user's workspace (no worktree)", async () => {
    const repo = await createGitFixture({ "a.txt": "x\n" });
    const { bridge, events } = await makeBridge();

    const handle = await bridge.start({ mode: "baseline", workspaceRoot: repo });

    expect(handle.workspaceKind).toBe("git");
    expect(handle.mode).toBe("baseline");
    expect(await samePath(handle.workspaceRoot, repo)).toBe(true);
    expect(handle.workspaceRoot).toBe(handle.userWorkspaceRoot);
    expect((await worktreePaths(repo))).toHaveLength(1); // only the main worktree
    expect(events.map((n) => n.event.type)).toEqual(["taskCreated"]);
    await bridge.disposeAll();
  });

  it("non-Git workspaces start as snapshot kind with a scanned baseline checkpoint", async () => {
    const workspace = await tempDir("ic-bridge-plain-");
    await fs.writeFile(path.join(workspace, "note.txt"), "hello\n", "utf8");
    const { bridge, events } = await makeBridge();

    const handle = await bridge.start({ mode: "baseline", workspaceRoot: workspace });

    expect(handle.workspaceKind).toBe("snapshot");
    expect(await samePath(handle.workspaceRoot, workspace)).toBe(true);
    const log = await bridge.listEvents(handle.taskId);
    expect(log[0]).toMatchObject({ type: "taskCreated", workspaceKind: "snapshot", mode: "baseline" });
    expect(events).toHaveLength(1);
    await bridge.disposeAll();
  });

  it("isolated mode on a non-Git workspace fails closed (no snapshot fallback)", async () => {
    const workspace = await tempDir("ic-bridge-plain2-");
    const { bridge } = await makeBridge();

    await expect(bridge.start({ mode: "isolated", workspaceRoot: workspace })).rejects.toThrow("isolated");
    expect(bridge.listTasks()).toEqual([]);
    await bridge.disposeAll();
  });
});

describe("taskRuntimeBridge port", () => {
  it("acquires the task lease BEFORE the workspace lease and releases in reverse", async () => {
    const workspace = await tempDir("ic-bridge-locks-");
    const order: string[] = [];
    const disposable = () => ({
      [Symbol.asyncDispose]: async () => {
        order.push("release");
      },
    });
    const recording = createTaskRuntimeBridge({
      taskStorageDir: await tempDir("ic-bridge-locks2-"),
      onTaskEvent: () => {},
      locks: {
        task: {
          async acquire(taskId) {
            order.push(`task:${taskId}`);
            return disposable();
          },
        },
        workspace: {
          async acquire(workspaceKey) {
            order.push(`workspace:${workspaceKey}`);
            return disposable();
          },
        },
      },
    });
    const handle = await recording.start({ mode: "baseline", workspaceRoot: workspace });
    const context = await handle.port.acquireMutationContext(taskScopeOf(handle.taskId));

    const taskIndex = order.findIndex((entry) => entry.startsWith("task:"));
    const workspaceIndex = order.findIndex((entry) => entry.startsWith("workspace:"));
    expect(taskIndex).toBeGreaterThanOrEqual(0);
    expect(workspaceIndex).toBeGreaterThan(taskIndex); // fixed task → workspace order

    await context[Symbol.asyncDispose]();
    expect(order.slice(-2)).toEqual(["release", "release"]); // both leases released
    await recording.disposeAll();
  });

  it("reports unknown external changes in the capture window, excluding the tool's own declared writes", async () => {
    const workspace = await tempDir("ic-bridge-watch-");
    await fs.writeFile(path.join(workspace, "declared.txt"), "before\n", "utf8");
    const { bridge } = await makeBridge();
    const handle = await bridge.start({ mode: "baseline", workspaceRoot: workspace });
    const port = handle.port;

    const context = await port.acquireMutationContext(taskScopeOf(handle.taskId));
    const before = await port.captureBefore(context, { paths: ["declared.txt"] });
    expect(before.paths).toEqual([{ path: "declared.txt", hash: before.paths[0]?.hash ?? null }]);

    // The tool's own declared write (already covered by changeRecorded) plus
    // an external write to an undeclared path.
    await fs.writeFile(path.join(workspace, "declared.txt"), "tool wrote this\n", "utf8");
    await fs.writeFile(path.join(workspace, "external.txt"), "someone else\n", "utf8");
    const after = await port.captureAfter(context, {
      paths: ["declared.txt"],
      expectedVersion: before.version,
    });
    expect(after.declared.map((p) => p.path)).toEqual(["declared.txt"]);
    const unknownPaths = after.unknown.map((change) => change.path);
    expect(unknownPaths).toContain("external.txt");
    expect(unknownPaths).not.toContain("declared.txt"); // own write, not unknown-source
    await context[Symbol.asyncDispose]();

    // The version is a CAS token: a stale expectedVersion must fail closed.
    const context2 = await port.acquireMutationContext(taskScopeOf(handle.taskId));
    await port.append(context2, { type: "attributionPending", paths: ["pending.txt"] });
    await expect(
      port.captureAfter(context2, { paths: [], expectedVersion: before.version }),
    ).rejects.toThrow();
    await context2[Symbol.asyncDispose]();
    await bridge.disposeAll();
  });

  it("appends plugin events to the single log and forwards them through the emitter", async () => {
    const workspace = await tempDir("ic-bridge-events-");
    const { bridge, events } = await makeBridge();
    const handle = await bridge.start({ mode: "baseline", workspaceRoot: workspace });

    const context = await handle.port.acquireMutationContext(taskScopeOf(handle.taskId));
    const change: TaskEvent = {
      type: "changeRecorded",
      path: "src/a.ts",
      source: "declared",
      beforeHash: null,
      afterHash: "abc",
    };
    await handle.port.append(context, change);
    await context[Symbol.asyncDispose]();

    // One log: core + plugin events replay through the SAME reducer.
    const log = await bridge.listEvents(handle.taskId);
    expect(log.map((event) => event.type)).toEqual(["taskCreated", "changeRecorded"]);
    expect(() => reduceTask([...log])).not.toThrow();
    expect(events.map((n) => n.event.type)).toEqual(["taskCreated", "changeRecorded"]);
    await bridge.disposeAll();
  });

  it("requireAttribution folds pending/conflict/resolved events from the log", async () => {
    const workspace = await tempDir("ic-bridge-attr-");
    const { bridge } = await makeBridge();
    const handle = await bridge.start({ mode: "baseline", workspaceRoot: workspace });
    const port = handle.port;

    const context = await port.acquireMutationContext(taskScopeOf(handle.taskId));
    await port.append(context, { type: "attributionPending", paths: ["a.txt", "b.txt"] });
    await port.append(context, { type: "attributionConflict", paths: ["b.txt"] });
    let decisions = await port.requireAttribution(context);
    expect(decisions.find((d) => d.path === "a.txt")).toMatchObject({ status: "attribution-pending" });
    expect(decisions.find((d) => d.path === "b.txt")).toMatchObject({ status: "conflict" });

    await port.append(context, {
      type: "attributionResolved",
      path: "a.txt",
      attribution: "task-owned",
      status: "pending-review",
      protectedHash: null,
    });
    decisions = await port.requireAttribution(context);
    expect(decisions.find((d) => d.path === "a.txt")).toMatchObject({ status: "pending-review" });
    await context[Symbol.asyncDispose]();
    await bridge.disposeAll();
  });
});

describe("taskRuntimeBridge.forkRoute", () => {
  it("forks from the persisted base commit and checkpoint after the original HEAD moves, then recovers", async () => {
    const repo = await createGitFixture({ "app.txt": "base\n", "keep.txt": "keep\n" });
    await fs.writeFile(path.join(repo, "dirty.txt"), "dirty baseline\n", "utf8");
    const storageDir = await tempDir("ic-bridge-fork-");
    const worktreeDir = path.join(storageDir, "worktrees");
    const bridge = createTaskRuntimeBridge({ taskStorageDir: storageDir, worktreeDir });
    const source = await bridge.start({
      taskId: "task_fork",
      sessionId: "session_fork",
      mode: "isolated",
      workspaceRoot: repo,
    });
    const sourceBase = (await gitExec(source.workspaceRoot, ["rev-parse", "HEAD"])).trim();
    const originalStatus = await gitExec(repo, ["status", "--porcelain=v1"]);
    const sourceEventsBefore = [...(await bridge.listEvents(source.taskId))];

    const checkpointBytes = new TextEncoder().encode("checkpoint one\n");
    const checkpointHash = sha256Bytes(checkpointBytes);
    const repository = await openTaskRepository(storageDir, source.taskId);
    await repository.objects.put(checkpointBytes);
    const checkpoint: Checkpoint = {
      checkpointId: "c1",
      taskId: source.taskId,
      routeId: "main",
      turnId: "a2",
      files: [
        { path: "app.txt", exists: true, hash: checkpointHash, mode: 0o100644, binary: false },
        { path: "future.txt", exists: false, hash: null, mode: null, binary: false },
      ],
    };
    await repository.writeCheckpoint(checkpoint);
    await repository.append([
      turnCheckpointedEvent({ checkpointId: "c1", routeId: "main", turnId: "a2", files: checkpoint.files }),
      turnPreparedEvent({
        turnId: "a2",
        checkpointId: "c1",
        routeId: "main",
        role: "assistant",
        prompt: "original prompt",
        parentCheckpointId: "c1",
      }),
      turnCommittedEvent({ turnId: "a2", checkpointId: "c1", routeId: "main" }),
    ]);

    // Move the user's repository HEAD after task start. Forking must ignore it.
    await fs.writeFile(path.join(repo, "app.txt"), "future commit\n", "utf8");
    await fs.writeFile(path.join(repo, "future.txt"), "future only\n", "utf8");
    await gitExec(repo, ["add", "app.txt", "future.txt"]);
    await gitExec(repo, ["commit", "-m", "move head after task start"]);

    const child = await bridge.forkRoute({
      sessionId: source.sessionId,
      taskId: source.taskId,
      sourceRouteId: "main",
      sourceTurnId: "a2",
      mode: "retry-assistant",
      routeName: "Retry a2",
    });

    expect(child.prompt).toBe("original prompt");

    expect(child.parentRouteId).toBe("main");
    expect(child.checkpointId).toBe("c1");
    expect(child.baseCommit).toBe(sourceBase);
    expect(await fileText(path.join(child.workspaceRoot, "app.txt"))).toBe("checkpoint one\n");
    expect(await fileText(path.join(child.workspaceRoot, "dirty.txt"))).toBe("dirty baseline\n");
    expect(await fileText(path.join(child.workspaceRoot, "future.txt"))).toBeNull();
    expect((await gitExec(child.workspaceRoot, ["rev-parse", "HEAD"])).trim()).toBe(sourceBase);
    expect(await gitExec(repo, ["status", "--porcelain=v1"])).toBe(originalStatus);
    expect((await bridge.listEvents(source.taskId)).slice(0, sourceEventsBefore.length)).toEqual(sourceEventsBefore);

    await bridge.disposeAll();
    const restarted = createTaskRuntimeBridge({ taskStorageDir: storageDir, worktreeDir });
    const recovered = await restarted.recoverTask(source.taskId);
    expect(recovered.routes.get(child.routeId)?.workspaceRoot).toBe(child.workspaceRoot);
    expect(await fileText(path.join(child.workspaceRoot, "app.txt"))).toBe("checkpoint one\n");
    expect((await gitExec(child.workspaceRoot, ["rev-parse", "HEAD"])).trim()).toBe(sourceBase);
    const recoveredChild = restarted.getRoute(source.taskId, child.routeId);
    expect(recoveredChild?.workspaceRoot).toBe(child.workspaceRoot);
    const context = await recoveredChild!.port.acquireMutationContext(taskScopeOf(source.taskId, child.routeId));
    await recoveredChild!.port.append(context, { type: "attributionPending", paths: ["continued.txt"] });
    await context[Symbol.asyncDispose]();
    expect((await restarted.listEvents(source.taskId)).at(-1)).toMatchObject({
      type: "attributionPending",
      paths: ["continued.txt"],
    });
    await restarted.disposeAll();
  }, 120_000);

  it("cleans the child worktree and leaves route state untouched when checkpoint bytes fail validation", async () => {
    const repo = await createGitFixture({ "app.txt": "base\n" });
    const storageDir = await tempDir("ic-bridge-fork-fail-");
    const worktreeDir = path.join(storageDir, "worktrees");
    const bridge = createTaskRuntimeBridge({ taskStorageDir: storageDir, worktreeDir });
    const source = await bridge.start({
      taskId: "task_fork_fail",
      sessionId: "session_fork_fail",
      mode: "isolated",
      workspaceRoot: repo,
    });
    const repository = await openTaskRepository(storageDir, source.taskId);
    const bytes = new TextEncoder().encode("expected\n");
    const hash = sha256Bytes(bytes);
    await repository.objects.put(bytes);
    const checkpoint: Checkpoint = {
      checkpointId: "c_bad",
      taskId: source.taskId,
      routeId: "main",
      turnId: "a_bad",
      files: [{ path: "app.txt", exists: true, hash, mode: 0o100644, binary: false }],
    };
    await repository.writeCheckpoint(checkpoint);
    await repository.append([
      turnCheckpointedEvent({ checkpointId: checkpoint.checkpointId, routeId: "main", turnId: "a_bad", files: checkpoint.files }),
      turnPreparedEvent({
        turnId: "a_bad",
        checkpointId: checkpoint.checkpointId,
        routeId: "main",
        role: "assistant",
        prompt: "original",
        parentCheckpointId: checkpoint.checkpointId,
      }),
      turnCommittedEvent({ turnId: "a_bad", checkpointId: checkpoint.checkpointId, routeId: "main" }),
    ]);
    await fs.writeFile(repository.objects.path(hash), "tampered\n", "utf8");
    const eventsBefore = await bridge.listEvents(source.taskId);
    const headBefore = await repository.readTaskHead();
    const worktreesBefore = await worktreePaths(repo);

    await expect(bridge.forkRoute({
      sessionId: source.sessionId,
      taskId: source.taskId,
      sourceRouteId: "main",
      sourceTurnId: "a_bad",
      mode: "retry-assistant",
      routeName: "bad retry",
    })).rejects.toThrow(/hash mismatch/i);

    expect(await bridge.listEvents(source.taskId)).toEqual(eventsBefore);
    expect(await repository.readTaskHead()).toEqual(headBefore);
    expect(await worktreePaths(repo)).toEqual(worktreesBefore);
    expect(bridge.getRoute(source.taskId, "main")?.workspaceRoot).toBe(source.workspaceRoot);
    await bridge.disposeAll();
  }, 120_000);
});

describe("taskRuntimeBridge lifecycle", () => {
  it("releaseTask stops the watcher and keeps the worktree; deleteTask destroys it", async () => {
    const repo = await createGitFixture({ "a.txt": "x\n" });
    const { bridge } = await makeBridge();
    const handle = await bridge.start({ mode: "isolated", workspaceRoot: repo });

    await bridge.releaseTask(handle.taskId);
    // Lease-only release: the worktree survives for the next app run.
    expect(await fileText(path.join(handle.workspaceRoot, "a.txt"))).toBe("x\n");
    const kept = await worktreePaths(repo);
    expect(await Promise.all(kept.map((p) => samePath(p, handle.workspaceRoot)))).toContain(true);
    // The task is no longer live: port mutations fail closed.
    await expect(
      handle.port.acquireMutationContext(taskScopeOf(handle.taskId)),
    ).rejects.toThrow();

    // Explicit deletion destroys the worktree.
    await bridge.deleteTask(handle.taskId);
    await expect(fs.access(handle.workspaceRoot)).rejects.toThrow();
    const remaining = await worktreePaths(repo);
    expect(await Promise.all(remaining.map((p) => samePath(p, handle.workspaceRoot)))).not.toContain(true);
    expect(bridge.listTasks()).toEqual([]);
  });

  it("disposeAll releases every task without destroying worktrees (app quit)", async () => {
    const repo = await createGitFixture({ "a.txt": "x\n" });
    const plain = await tempDir("ic-bridge-quit-");
    const { bridge } = await makeBridge();
    const isolated = await bridge.start({ mode: "isolated", workspaceRoot: repo });
    const snapshot = await bridge.start({ mode: "baseline", workspaceRoot: plain });

    await bridge.disposeAll();
    expect(bridge.listTasks()).toEqual([]);
    // Worktrees survive quit (explicit deletion only); snapshot tasks have nothing on disk to keep.
    expect(await fileText(path.join(isolated.workspaceRoot, "a.txt"))).toBe("x\n");
    await expect(fs.access(plain)).resolves.toBeUndefined();
    void snapshot;
  });

  it("resolveTaskWorkspaceRoot prefers the session-bound root over the settings fallback", () => {
    expect(
      resolveTaskWorkspaceRoot("s1", {
        getSessionWorkspaceRoot: (id) => (id === "s1" ? "D:/proj/session" : undefined),
        fallbackRoot: "D:/settings",
      }),
    ).toBe("D:/proj/session");
    expect(
      resolveTaskWorkspaceRoot("s2", {
        getSessionWorkspaceRoot: () => undefined,
        fallbackRoot: "D:/settings",
      }),
    ).toBe("D:/settings");
  });
});

/** Realpath-based path equality: git prints short-form/forward-slash paths
 *  while the bridge hands out path.resolve forms — both must canonicalize. */
async function samePath(a: string, b: string): Promise<boolean> {
  const canonical = async (value: string): Promise<string> => {
    try {
      return await fs.realpath(value);
    } catch {
      return path.resolve(value);
    }
  };
  const [ca, cb] = await Promise.all([canonical(a),canonical(b)]);
  const norm = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  return norm(ca) === norm(cb);
}
