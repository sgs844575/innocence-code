// P1 bootstrap acceptance (Task 14, brief step 3): the FORK ISOLATION closed
// loop over the REAL stack. A committed historical turn is retried (or
// re-forked from an edited user message) into a child route whose worktree is
// rebuilt from the immutable baseCommit + the target checkpoint; the child
// continues, is reviewed, and only the final three-way-preflighted apply ever
// writes into the ORIGINAL user workspace. The loop asserts the P1 contract:
// the main route, the main workspace and the Git index stay byte-identical
// until that final apply, after which only accepted content lands.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openTaskRepository, sha256Bytes } from "@innocencecode/task-workspace";
import type { Checkpoint, TaskEvent } from "@innocencecode/task-core";
import { turnCheckpointedEvent, turnCommittedEvent, turnPreparedEvent } from "@innocencecode/task-core";
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

const FIXTURE_FILES = {
  "app.txt": "app base\n",
  "keep.txt": "keep\n",
  "staged.txt": "original\n",
} as const;

/** Committed base + staged change + untracked file (the index-preservation bait). */
async function createForkFixture(): Promise<string> {
  const root = await tempDir("ic-fork-git-");
  await gitExec(root, ["init", "-b", "main"]);
  await gitExec(root, ["config", "user.name", "Fork Fixture"]);
  await gitExec(root, ["config", "user.email", "fork@example.invalid"]);
  await gitExec(root, ["config", "core.autocrlf", "false"]);
  for (const [name, content] of Object.entries(FIXTURE_FILES)) {
    await fs.writeFile(path.join(root, name), content, "utf8");
  }
  await gitExec(root, ["add", "-A"]);
  await gitExec(root, ["commit", "-m", "fixture base"]);
  await fs.writeFile(path.join(root, "staged.txt"), "original\nstaged change\n", "utf8");
  await gitExec(root, ["add", "staged.txt"]);
  await fs.writeFile(path.join(root, "untracked.txt"), "user notes\n", "utf8");
  return root;
}

/** The worktree state the isolated start materializes (HEAD + baseline overlay). */
const OVERLAY_FILES: Record<string, string> = {
  ...FIXTURE_FILES,
  "staged.txt": "original\nstaged change\n",
  "untracked.txt": "user notes\n",
};

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
  const added = [...after.keys()].filter((key) => !before.has(key));
  const removed = [...before.keys()].filter((key) => !after.has(key));
  expect(`added: ${added.join(",")}; removed: ${removed.join(",")}`, context).toBe("added: ; removed: ");
  for (const [key, bytes] of before) {
    expect(Buffer.from(after.get(key)!).equals(bytes), `${context}: ${key} must be byte-identical`).toBe(true);
  }
}

/** Full-workspace committed turn: checkpoint + prepared + committed (role-configurable). */
async function seedCommittedTurn(options: {
  storageDir: string;
  taskId: string;
  turnId: string;
  role: "user" | "assistant";
  prompt: string;
  files: Record<string, string>;
  /** Checkpoint the turn ran FROM (the retry/fork target); defaults to the turn's own checkpoint. */
  parentCheckpointId?: string;
}): Promise<void> {
  const repository = await openTaskRepository(options.storageDir, options.taskId);
  const checkpointId = `ckpt_${options.turnId}`;
  const files = await Promise.all(
    Object.entries(options.files).map(async ([name, content]) => {
      const bytes = new TextEncoder().encode(content);
      const hash = sha256Bytes(bytes);
      await repository.objects.put(bytes);
      return { path: name, exists: true, hash, mode: 0o100644, binary: false };
    }),
  );
  const checkpoint: Checkpoint = {
    checkpointId, taskId: options.taskId, routeId: "main", turnId: options.turnId, files,
  };
  await repository.writeCheckpoint(checkpoint);
  const events: TaskEvent[] = [
    turnCheckpointedEvent({ checkpointId, routeId: "main", turnId: options.turnId, files }),
    turnPreparedEvent({
      turnId: options.turnId, checkpointId, routeId: "main", role: options.role,
      prompt: options.prompt, parentCheckpointId: options.parentCheckpointId ?? checkpointId,
    }),
    turnCommittedEvent({ turnId: options.turnId, checkpointId, routeId: "main" }),
  ];
  await repository.append(events);
}

async function fileText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

describe("git index preservation acceptance: fork isolation loop", () => {
  it("retries a committed turn into a child worktree and defers every original write to the final apply", async () => {
    const repo = await createForkFixture();
    const storageDir = await tempDir("ic-fork-store-");

    // the byte-identical baseline of the ORIGINAL workspace
    const originalBefore = await byteSnapshot(repo);
    const stagedDiffBefore = await gitExec(repo, ["diff", "--cached"]);
    const indexBefore = await gitExec(repo, ["ls-files", "-s"]);
    expect(stagedDiffBefore).toContain("staged change"); // non-empty index

    const runtime = await createTaskCliRuntime({ storageDir });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({
      workspaceRoot: repo, mode: "isolated", sessionId: "session_fork", taskId: "task_fork",
    });
    const baseCommit = (await gitExec(task.workspaceRoot, ["rev-parse", "HEAD"])).trim();
    expect(baseCommit).toBe((await gitExec(repo, ["rev-parse", "HEAD"])).trim());

    // a committed assistant turn: it RAN FROM the task's baseline checkpoint
    // (the pre-turn state the retry must restore) and produced its own
    // post-turn checkpoint — realistic history for a retry-from-history fork
    await seedCommittedTurn({
      storageDir, taskId: task.taskId, turnId: "turn_a1", role: "assistant", prompt: "original prompt",
      files: { ...OVERLAY_FILES, "app.txt": "checkpoint one\n" },
      parentCheckpointId: task.baselineCheckpointId,
    });

    // the isolated start itself never touched the original workspace or index
    expectSnapshotsIdentical(originalBefore, await byteSnapshot(repo), "after isolated start");
    expect(await gitExec(repo, ["diff", "--cached"])).toBe(stagedDiffBefore);

    // -- retry from history → child route/worktree from the immutable baseCommit
    const retried = await cli.retryAssistant({
      sessionId: "session_fork", taskId: task.taskId,
      sourceRouteId: task.activeRouteId, sourceTurnId: "turn_a1", routeName: "Retry a1",
    });
    expect(retried.prompt).toBe("original prompt");
    expect(retried.route.parentRouteId).toBe(task.activeRouteId);
    const childRoot = retried.route.workspaceRoot!;
    expect(childRoot).not.toBe(task.workspaceRoot);
    // the TARGET checkpoint (the turn's parent = the task baseline) is
    // restored into the child: HEAD content PLUS the baseline overlay —
    // staged.txt and untracked.txt only exist through the checkpoint replay
    expect(await fileText(path.join(childRoot, "app.txt"))).toBe("app base\n");
    expect(await fileText(path.join(childRoot, "staged.txt"))).toBe("original\nstaged change\n");
    expect(await fileText(path.join(childRoot, "untracked.txt"))).toBe("user notes\n");
    expect((await gitExec(childRoot, ["rev-parse", "HEAD"])).trim()).toBe(baseCommit);
    // the fork switched the active route but wrote nothing anywhere else
    expect((await cli.getTask(task.taskId)).activeRouteId).toBe(retried.route.routeId);
    expectSnapshotsIdentical(originalBefore, await byteSnapshot(repo), "after fork");
    expect(await gitExec(repo, ["diff", "--cached"])).toBe(stagedDiffBefore);
    expect(await fileText(path.join(task.workspaceRoot, "app.txt"))).toBe("app base\n"); // main worktree untouched

    // -- the child continues executing (agent seam: real file writes) — the
    // retry re-runs the turn from the restored checkpoint state
    await fs.writeFile(path.join(childRoot, "app.txt"), "app base\nchild change\n", "utf8");
    await fs.writeFile(path.join(childRoot, "child.txt"), "child output\n", "utf8");

    // review: ONLY the child's own changes appear (full-state checkpoint ⇒
    // no phantom hunks for the user's staged/untracked files)
    const hunks = await cli.listHunks(task.taskId, retried.route.routeId);
    expect([...new Set(hunks.map((hunk) => hunk.path))].sort()).toEqual(["app.txt", "child.txt"]);
    for (const hunk of hunks) {
      await cli.review({ taskId: task.taskId, routeId: retried.route.routeId, hunkRef: hunk.ref, status: "accepted" });
    }
    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: false })).resolves.toBeUndefined();

    // still nothing landed in the original workspace or index after review
    expectSnapshotsIdentical(originalBefore, await byteSnapshot(repo), "after child review");
    expect(await gitExec(repo, ["diff", "--cached"])).toBe(stagedDiffBefore);
    expect(await gitExec(repo, ["ls-files", "-s"])).toBe(indexBefore);

    // -- three-way preflight on the ORIGINAL workspace, then the final apply
    const preflight = await runtime.service.applyAccepted(task.taskId, retried.route.routeId, { dryRun: true });
    expect(preflight.conflicts).toEqual([]);
    expect(preflight.applied).toEqual([]);
    expectSnapshotsIdentical(originalBefore, await byteSnapshot(repo), "after dry-run preflight");

    const applied = await cli.applyAccepted(task.taskId, retried.route.routeId);
    expect(applied.conflicts).toEqual([]);
    expect(applied.applied.sort()).toEqual(["app.txt", "child.txt"]);
    // only accepted content lands; every preserved file stays byte-identical
    expect(await fileText(path.join(repo, "app.txt"))).toBe("app base\nchild change\n");
    expect(await fileText(path.join(repo, "child.txt"))).toBe("child output\n");
    const originalAfter = await byteSnapshot(repo);
    for (const key of originalBefore.keys()) {
      if (key === "app.txt") continue; // the applied file, asserted above
      expect(Buffer.from(originalAfter.get(key)!).equals(originalBefore.get(key)!), `${key}`).toBe(true);
    }
    // the Git index never moved — staged change and untracked file intact
    expect(await gitExec(repo, ["diff", "--cached"])).toBe(stagedDiffBefore);
    expect(await gitExec(repo, ["ls-files", "-s"])).toBe(indexBefore);
    expect((await gitExec(repo, ["status", "--porcelain"])).split("\n")).toEqual(
      expect.arrayContaining([" M app.txt", "M  staged.txt", "?? child.txt", "?? untracked.txt"]),
    );
    // the MAIN route's worktree is still at its own state (apply is route-scoped)
    expect(await fileText(path.join(task.workspaceRoot, "app.txt"))).toBe("app base\n");
    // both routes remain in the DAG with the right parent link
    const routes = await cli.listRoutes(task.taskId);
    expect(routes).toHaveLength(2);
    expect(routes.find((route) => route.routeId === retried.route.routeId)).toMatchObject({
      parentRouteId: task.activeRouteId,
      forkTurnId: "turn_a1",
    });
  }, 120_000);

  it("editing a historical user message forks from that turn's checkpoint with the edited prompt", async () => {
    const repo = await createForkFixture();
    const storageDir = await tempDir("ic-fork-user-");
    const originalBefore = await byteSnapshot(repo);

    const runtime = await createTaskCliRuntime({ storageDir });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({
      workspaceRoot: repo, mode: "isolated", sessionId: "session_user", taskId: "task_user",
    });
    const baseCommit = (await gitExec(task.workspaceRoot, ["rev-parse", "HEAD"])).trim();
    const stagedDiffBefore = await gitExec(repo, ["diff", "--cached"]);

    // a committed USER turn (the message being edited) at an earlier checkpoint
    await seedCommittedTurn({
      storageDir, taskId: task.taskId, turnId: "turn_u1", role: "user", prompt: "original question",
      files: { ...OVERLAY_FILES, "app.txt": "user-era state\n" },
    });

    const forked = await cli.forkFromUser({
      sessionId: "session_user", taskId: task.taskId,
      sourceRouteId: task.activeRouteId, sourceTurnId: "turn_u1", routeName: "Edit u1",
      editedText: "edited question",
    });
    expect(forked.prompt).toBe("edited question");
    const childRoot = forked.route.workspaceRoot!;
    expect(await fileText(path.join(childRoot, "app.txt"))).toBe("user-era state\n"); // checkpoint restored
    expect((await gitExec(childRoot, ["rev-parse", "HEAD"])).trim()).toBe(baseCommit); // immutable base
    expect((await cli.getTask(task.taskId)).activeRouteId).toBe(forked.route.routeId);

    // the original workspace, the main worktree and the index are untouched
    expectSnapshotsIdentical(originalBefore, await byteSnapshot(repo), "after user-edit fork");
    expect(await fileText(path.join(task.workspaceRoot, "app.txt"))).toBe("app base\n");
    expect(await gitExec(repo, ["diff", "--cached"])).toBe(stagedDiffBefore);
  }, 120_000);
});
