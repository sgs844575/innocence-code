// P1 bootstrap acceptance (Task 14, brief step 4): crash and failure states
// over the REAL stack. Every scenario drives packages/task-cli's
// createTaskCliRuntime (real task-workspace repository + real task-git
// adapter + real child processes) and asserts the two contract points of the
// P1 checklist: the correct status surfaces, and errors never fake
// completion — no half-written task, no orphan worktree, no swallowed event.
//
// Scenarios: crash-torn final event line, checkpoint write failure, worktree
// creation failure, shell timeout whose process refuses to exit, and an
// external conflict during the final apply.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand, bashTool } from "@innocencecode/tools-shell";
import { createExecutionScope } from "@innocencecode/harness-core";
import { createGitAdapter, type GitAdapter } from "@innocencecode/task-git";
import { TaskRecoveryError } from "@innocencecode/task-core";
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

async function createGitFixture(files: Record<string, string>): Promise<string> {
  const root = await tempDir("ic-crash-git-");
  await gitExec(root, ["init", "-b", "main"]);
  await gitExec(root, ["config", "user.name", "Crash Fixture"]);
  await gitExec(root, ["config", "user.email", "crash@example.invalid"]);
  await gitExec(root, ["config", "core.autocrlf", "false"]);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), content, "utf8");
  }
  await gitExec(root, ["add", "-A"]);
  await gitExec(root, ["commit", "-m", "fixture base"]);
  return root;
}

async function fileText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Non-empty `git worktree list` lines = registered worktrees of the repo. */
async function registeredWorktrees(repoRoot: string): Promise<number> {
  const output = await gitExec(repoRoot, ["worktree", "list"]);
  return output.split("\n").filter((line) => line.trim().length > 0).length;
}

async function eventsPath(storageDir: string, taskId: string): Promise<string> {
  return path.join(storageDir, "tasks", taskId, "events.jsonl");
}

/** Replaces the task's checkpoints DIRECTORY with a file → every checkpoint write fails. */
async function breakCheckpointWrites(storageDir: string, taskId: string): Promise<void> {
  const checkpointsDir = path.join(storageDir, "tasks", taskId, "checkpoints");
  await fs.rm(checkpointsDir, { recursive: true, force: true });
  await fs.writeFile(checkpointsDir, "checkpoint storage is broken", "utf8");
}

/**
 * Replaces the task's `temp` staging directory with a file → every
 * writeFileAtomic (new checkpoint/object writes) fails while existing files
 * stay readable: a durable task whose NEXT checkpoint write fails.
 */
async function breakAtomicWrites(storageDir: string, taskId: string): Promise<void> {
  const tempDir = path.join(storageDir, "tasks", taskId, "temp");
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.writeFile(tempDir, "atomic write staging is broken", "utf8");
}

/** Seeds a committed turn (checkpoint + prepared + committed) through the real repository. */
async function seedCommittedTurn(options: {
  storageDir: string;
  taskId: string;
  turnId: string;
  role: "user" | "assistant";
  prompt: string;
  files: Record<string, string>;
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
      prompt: options.prompt, parentCheckpointId: checkpointId,
    }),
    turnCommittedEvent({ turnId: options.turnId, checkpointId, routeId: "main" }),
  ];
  await repository.append(events);
}

// ---------------------------------------------------------------------------
// 1. 崩溃半行 event — a crash tears the FINAL event line mid-append
// ---------------------------------------------------------------------------

describe("crash recovery acceptance", () => {
  it("a torn final event line is ignored and reported, repaired before the next append, and never fake-completes", async () => {
    const repo = await createGitFixture({ "a.txt": "base\n" });
    const storageDir = await tempDir("ic-crash-torn-");
    const runtime = await createTaskCliRuntime({
      storageDir,
      agentWriter: async (task) => {
        await fs.writeFile(path.join(task.workspaceRoot, "a.txt"), "base\nagent change\n", "utf8");
      },
    });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({ workspaceRoot: repo, mode: "baseline" });

    // crash mid-append: a HALF-WRITTEN fake completion event (no closing
    // brace, no terminating newline) — the most dangerous torn tail possible
    const torn = '{"type":"taskStatus","status":"completed","eventId":"evt_torn';
    await fs.appendFile(await eventsPath(storageDir, task.taskId), torn, "utf8");

    // reads: the torn tail is ignored AND reported; the fake status never lands
    const repository = await openTaskRepository(storageDir, task.taskId);
    const recovery = await repository.recoverEventLog();
    expect(recovery?.truncatedTail).toBe(true);
    expect(recovery?.recoveredEvents.some((event) => event.type === "taskStatus")).toBe(false);
    expect(await cli.getTask(task.taskId)).not.toMatchObject({ status: "completed" });

    // no fake completion: the gate still blocks on the unreviewed agent change
    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: false }))
      .rejects.toMatchObject({ code: "completion-gate" });

    // the next append REPAIRS first: the torn fragment is dropped (it can
    // never merge with the appended event) and the loop then finishes cleanly
    const hunks = await cli.listHunks(task.taskId, task.activeRouteId);
    expect(hunks).toHaveLength(1);
    await cli.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: hunks[0]!.ref, status: "accepted" });
    const raw = await fs.readFile(await eventsPath(storageDir, task.taskId), "utf8");
    expect(raw).not.toContain("evt_torn"); // the fragment was not swallowed into the new event
    expect(raw.trimEnd().endsWith('}')).toBe(true);
    const events = await repository.list();
    expect(events.some((event) => event.type === "taskStatus" && event.status === "completed")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "hunkReviewed", status: "accepted" });
    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: false })).resolves.toBeUndefined();
  }, 120_000);

  it("a corrupt newline-terminated final line refuses every append (fail closed) without faking completion", async () => {
    const repo = await createGitFixture({ "a.txt": "base\n" });
    const storageDir = await tempDir("ic-crash-closed-");
    const runtime = await createTaskCliRuntime({
      storageDir,
      agentWriter: async (task) => {
        await fs.writeFile(path.join(task.workspaceRoot, "a.txt"), "base\nagent change\n", "utf8");
      },
    });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({ workspaceRoot: repo, mode: "baseline" });

    // a final line that is corrupt BUT newline-terminated: reads tolerate it
    // as a truncated tail, but repair must refuse to decide its fate —
    // appending is denied so the corrupt line can never swallow the next event
    const corrupt = '{"type":"taskStatus","status":"completed"} trailing garbage\n';
    const eventsFile = await eventsPath(storageDir, task.taskId);
    await fs.appendFile(eventsFile, corrupt, "utf8");

    const repository = await openTaskRepository(storageDir, task.taskId);
    const recovery = await repository.recoverEventLog();
    expect(recovery?.truncatedTail).toBe(true);

    const hunks = await cli.listHunks(task.taskId, task.activeRouteId);
    await expect(
      cli.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: hunks[0]!.ref, status: "accepted" }),
    ).rejects.toBeInstanceOf(TaskRecoveryError);

    // side effects forbidden: the log is unchanged (no merged event), the task
    // never completes, and the fake status is still not part of the state
    const raw = await fs.readFile(eventsFile, "utf8");
    expect(raw).toContain(corrupt.trimEnd());
    expect(await repository.list().then((events) => events.at(-1)?.type)).not.toBe("hunkReviewed");
    expect(await cli.getTask(task.taskId)).not.toMatchObject({ status: "completed" });
    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: false }))
      .rejects.toMatchObject({ code: "completion-gate" });
  }, 120_000);

  // -------------------------------------------------------------------------
  // 2. checkpoint 写失败
  // -------------------------------------------------------------------------

  it("a checkpoint write failure during isolated start leaves nothing durable and destroys the worktree", async () => {
    const repo = await createGitFixture({ "a.txt": "base\n", "keep.txt": "keep\n" });
    const storageDir = await tempDir("ic-crash-ckpt-");
    const taskId = "task_ckptfail";
    let agentRan = false;

    // Sabotage exactly between worktree creation and the checkpoint write:
    // overlayBaseline is the only seam the runtime calls in that window.
    const real = createGitAdapter();
    const git: GitAdapter = {
      ...real,
      async overlayBaseline(lease, baseline) {
        await real.overlayBaseline(lease, baseline);
        await breakCheckpointWrites(storageDir, taskId);
      },
    };
    const runtime = await createTaskCliRuntime({
      storageDir,
      git,
      agentWriter: async () => {
        agentRan = true;
      },
    });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });

    await expect(cli.start({ workspaceRoot: repo, mode: "isolated", taskId })).rejects.toThrow();

    // correct status: the task never became durable — no event log, not found
    expect(await fs.stat(await eventsPath(storageDir, taskId)).then(() => true, () => false)).toBe(false);
    await expect(cli.getTask(taskId)).rejects.toMatchObject({ code: "task-not-found" });
    // forbidden side effects: no orphan worktree, the agent never ran, the
    // original workspace is untouched
    expect(await fs.stat(path.join(storageDir, "worktrees", taskId)).then(() => true, () => false)).toBe(false);
    expect(agentRan).toBe(false);
    expect(await fileText(path.join(repo, "a.txt"))).toBe("base\n");
    expect(await fileText(path.join(repo, "keep.txt"))).toBe("keep\n");
    // the repo carries no leftover worktree registration
    expect(await registeredWorktrees(repo)).toBe(1);
  }, 120_000);

  it("a checkpoint failure on a durable task records checkpoint-failed and never fakes progress", async () => {
    const repo = await createGitFixture({ "a.txt": "base\n" });
    const storageDir = await tempDir("ic-crash-ckpt2-");
    const runtime = await createTaskCliRuntime({
      storageDir,
      agentWriter: async (task) => {
        await fs.writeFile(path.join(task.workspaceRoot, "a.txt"), "base\nagent change\n", "utf8");
      },
    });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({ workspaceRoot: repo, mode: "baseline" });
    const eventsBefore = await (await openTaskRepository(storageDir, task.taskId)).list();

    await breakAtomicWrites(storageDir, task.taskId);
    await expect(runtime.service.createCheckpoint(task.taskId, task.activeRouteId)).rejects.toThrow();

    // no turnCheckpointed event was appended by the failed attempt
    const repository = await openTaskRepository(storageDir, task.taskId);
    const eventsAfter = await repository.list();
    expect(eventsAfter).toHaveLength(eventsBefore.length);
    // the host records the correct status through the typed escape hatch
    await runtime.service.changeStatus(task.taskId, "checkpoint-failed");
    expect(await cli.getTask(task.taskId)).toMatchObject({ status: "checkpoint-failed" });
    // and completion is still gated by the unreviewed agent change — a
    // checkpoint failure can never fake its way past the gate
    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: false }))
      .rejects.toMatchObject({ code: "completion-gate" });
  }, 120_000);

  // -------------------------------------------------------------------------
  // 3. worktree 创建失败
  // -------------------------------------------------------------------------

  it("a worktree creation failure fails closed at start and leaves fork state untouched", async () => {
    const repo = await createGitFixture({ "app.txt": "base\n", "keep.txt": "keep\n" });
    const storageDir = await tempDir("ic-crash-wt-");
    const real = createGitAdapter();
    let worktreeCalls = 0;
    let agentRan = false;
    const failAfterFirst: GitAdapter = {
      ...real,
      async createWorktree(input) {
        worktreeCalls += 1;
        if (worktreeCalls > 1) {
          throw new Error("simulated worktree creation failure");
        }
        return real.createWorktree(input);
      },
    };
    const runtime = await createTaskCliRuntime({
      storageDir,
      git: failAfterFirst,
      agentWriter: async () => {
        agentRan = true;
      },
    });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });

    // (a) the FIRST worktree creation (isolated start) fails → nothing durable
    const failingRuntime = await createTaskCliRuntime({
      storageDir,
      git: {
        ...real,
        async createWorktree() {
          throw new Error("simulated worktree creation failure");
        },
      },
      agentWriter: async () => {
        agentRan = true;
      },
    });
    const failingCli = createTaskCliAdapter({ taskRuntime: failingRuntime, output: collectStructuredOutput() });
    await expect(failingCli.start({ workspaceRoot: repo, mode: "isolated", taskId: "task_wtfail" }))
      .rejects.toThrow("simulated worktree creation failure");
    expect(agentRan).toBe(false);
    expect(await fs.stat(await eventsPath(storageDir, "task_wtfail")).then(() => true, () => false)).toBe(false);
    await expect(failingCli.getTask("task_wtfail")).rejects.toMatchObject({ code: "task-not-found" });
    expect(await fs.stat(path.join(storageDir, "worktrees", "task_wtfail")).then(() => true, () => false)).toBe(false);

    // (b) a healthy task, then the FORK's worktree creation fails → the main
    // route, its worktree and the event log all stay untouched
    const task = await cli.start({ workspaceRoot: repo, mode: "isolated", sessionId: "session_wt", taskId: "task_wtok" });
    expect(worktreeCalls).toBe(1); // only the main isolated worktree so far
    await seedCommittedTurn({
      storageDir, taskId: task.taskId, turnId: "turn_a1", role: "assistant", prompt: "do work",
      files: { "app.txt": "turn one\n", "keep.txt": "keep\n" },
    });
    const routesBefore = await cli.listRoutes(task.taskId);
    const versionBefore = (await cli.getTask(task.taskId)).version;
    const headBefore = await gitExec(task.workspaceRoot, ["rev-parse", "HEAD"]);

    await expect(
      cli.retryAssistant({
        sessionId: "session_wt", taskId: task.taskId,
        sourceRouteId: task.activeRouteId, sourceTurnId: "turn_a1", routeName: "Retry a1",
      }),
    ).rejects.toThrow("simulated worktree creation failure");

    expect(await cli.listRoutes(task.taskId)).toEqual(routesBefore); // no half-attached route
    expect(await cli.getTask(task.taskId)).toMatchObject({
      activeRouteId: task.activeRouteId, // still the main route
      version: versionBefore, // no event was appended
    });
    expect(await gitExec(task.workspaceRoot, ["rev-parse", "HEAD"])).toBe(headBefore);
    // no orphan child worktree registration was left behind (main repo + the
    // task's isolated worktree, nothing more)
    expect(await registeredWorktrees(repo)).toBe(2);
    expect(await fileText(path.join(repo, "app.txt"))).toBe("base\n"); // original untouched
  }, 120_000);

  // -------------------------------------------------------------------------
  // 4. Shell 超时不退出
  // -------------------------------------------------------------------------

  it("a shell command that ignores the timeout is force-killed, reported as an error, and never fakes completion", async () => {
    const repo = await createGitFixture({ "a.txt": "base\n" });
    // a real child that writes a file and then NEVER exits on its own
    await fs.writeFile(path.join(repo, "spin.js"), [
      'require("node:fs").writeFileSync("marker.txt", "spinning\\n");',
      "setInterval(() => {}, 1 << 30);",
      "",
    ].join("\n"), "utf8");
    const spinCommand = `"${process.execPath}" spin.js`;

    // the task starts BEFORE the timed-out command: marker.txt then arrives as
    // an unreviewed workspace change the completion gate must catch
    const storageDir = await tempDir("ic-crash-shell-");
    const runtime = await createTaskCliRuntime({ storageDir });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({ workspaceRoot: repo, mode: "baseline" });

    // the shell tool's REAL timeout path: the command would never exit; the
    // timeout must terminate the whole tree (taskkill /T /F) and settle
    const started = Date.now();
    const result = await runCommand({ command: spinCommand, cwd: repo, timeoutMs: 2_500 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000); // settled via the kill, not by hanging
    expect(await fileText(path.join(repo, "marker.txt"))).toBe("spinning\n"); // the effect happened

    // the Bash tool surfaces the same outcome as an ERROR result
    const toolResult = await bashTool.execute(
      { command: spinCommand, timeoutMs: 2_500 },
      {
        workspaceRoot: repo,
        signal: new AbortController().signal,
        log: () => {},
        scope: createExecutionScope("Bash"),
      },
    );
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toContain("命令超时");

    // task semantics: a timed-out tool's change stays unreviewed work — the
    // completion gate blocks until the user reviews it (no fake completion)
    const hunks = await cli.listHunks(task.taskId, task.activeRouteId);
    expect(hunks.map((hunk) => hunk.path)).toEqual(["marker.txt"]);
    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: false }))
      .rejects.toMatchObject({ code: "completion-gate" });
    for (const hunk of hunks) {
      await cli.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: hunk.ref, status: "accepted" });
    }
    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: false })).resolves.toBeUndefined();
  }, 120_000);

  // -------------------------------------------------------------------------
  // 5. 外部冲突
  // -------------------------------------------------------------------------

  it("an external conflict during apply reports conflicts, writes nothing, then applies after resolution", async () => {
    const repo = await createGitFixture({ "shared.txt": "base content\n", "other.txt": "stable\n" });
    // a staged change proves the index survives the whole conflict dance
    await fs.writeFile(path.join(repo, "other.txt"), "stable\nuser staged\n", "utf8");
    await gitExec(repo, ["add", "other.txt"]);
    const stagedBefore = await gitExec(repo, ["diff", "--cached"]);

    const storageDir = await tempDir("ic-crash-conflict-");
    const runtime = await createTaskCliRuntime({
      storageDir,
      agentWriter: async (task) => {
        await fs.writeFile(path.join(task.workspaceRoot, "shared.txt"), "base content\nagent accepted change\n", "utf8");
        await fs.writeFile(path.join(task.workspaceRoot, "feature.txt"), "new feature file\n", "utf8");
      },
    });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({ workspaceRoot: repo, mode: "isolated" });

    for (const hunk of await cli.listHunks(task.taskId, task.activeRouteId)) {
      await cli.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: hunk.ref, status: "accepted" });
    }
    await cli.complete({ taskId: task.taskId, confirmValidationFailure: false });

    // external concurrent modification of the ORIGINAL workspace after review
    await fs.writeFile(path.join(repo, "shared.txt"), "base content\nexternal edit\n", "utf8");

    // three-way preflight on the ORIGINAL workspace: conflict, no writes
    const preflight = await runtime.service.applyAccepted(task.taskId, task.activeRouteId, { dryRun: true });
    expect(preflight.applied).toEqual([]);
    expect(preflight.conflicts.map((conflict) => conflict.path)).toEqual(["shared.txt"]);
    const conflicted = await cli.applyAccepted(task.taskId, task.activeRouteId);
    expect(conflicted.applied).toEqual([]);
    expect(conflicted.conflicts.map((conflict) => conflict.path)).toEqual(["shared.txt"]);
    // ALL-OR-NOTHING: the conflicting batch wrote nothing at all
    expect(await fileText(path.join(repo, "shared.txt"))).toBe("base content\nexternal edit\n"); // external bytes intact
    expect(await fileText(path.join(repo, "feature.txt"))).toBeNull(); // the clean file did NOT land
    expect(await gitExec(repo, ["diff", "--cached"])).toBe(stagedBefore); // index untouched

    // resolution: the user withdraws the external edit → apply succeeds
    await fs.writeFile(path.join(repo, "shared.txt"), "base content\n", "utf8");
    const applied = await cli.applyAccepted(task.taskId, task.activeRouteId);
    expect(applied.conflicts).toEqual([]);
    expect(applied.applied.sort()).toEqual(["feature.txt", "shared.txt"]);
    expect(await fileText(path.join(repo, "shared.txt"))).toBe("base content\nagent accepted change\n");
    expect(await fileText(path.join(repo, "feature.txt"))).toBe("new feature file\n");
    expect(await gitExec(repo, ["diff", "--cached"])).toBe(stagedBefore);
  }, 120_000);
});
