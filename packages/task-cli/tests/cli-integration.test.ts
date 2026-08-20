// Task CLI integration (Task 13): the full review loop over REAL storage
// (task-workspace repository + CAS + locks), REAL Git fixtures and REAL
// child processes — no Electron, no React, no renderer. The CLI adapter only
// delegates to @innocencecode/task-core's TaskCommandService and renders
// through the injected output port; agent activity is simulated by the
// runtime's agent-writer seam (the same pattern plugin-task's tests use for
// its fake runtime).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import url from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { foldAttributionDecisions, hasUnresolvedAttribution } from "@innocencecode/plugin-task";
import { openTaskRepository, sha256Bytes } from "@innocencecode/task-workspace";
import type { Checkpoint, TaskEvent } from "@innocencecode/task-core";
import { turnCommittedEvent, turnPreparedEvent, turnCheckpointedEvent } from "@innocencecode/task-core";
import {
  collectStructuredOutput,
  createTaskCliAdapter,
  createTaskCliRuntime,
} from "../src/index";

const execFileAsync = promisify(execFile);
const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

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

/** Real temporary Git repository with a committed base. */
async function createGitFixture(files: Record<string, string>): Promise<string> {
  const root = await tempDir("ic-cli-git-");
  await gitExec(root, ["init", "-b", "main"]);
  await gitExec(root, ["config", "user.name", "CLI Fixture"]);
  await gitExec(root, ["config", "user.email", "cli@example.invalid"]);
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

async function fileText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Seeds a committed assistant turn (checkpoint + prepared + committed). */
async function seedAssistantTurn(options: {
  storageDir: string;
  taskId: string;
  files: Record<string, string>;
  prompt: string;
  turnId?: string;
  committed?: boolean;
}): Promise<void> {
  const turnId = options.turnId ?? "turn_a1";
  const repository = await openTaskRepository(options.storageDir, options.taskId);
  const checkpointId = `ckpt_${turnId}`;
  const files = await Promise.all(
    Object.entries(options.files).map(async ([name, content]) => {
      const bytes = new TextEncoder().encode(content);
      const hash = sha256Bytes(bytes);
      await repository.objects.put(bytes);
      return { path: name, exists: true, hash, mode: 0o100644, binary: false };
    }),
  );
  const checkpoint: Checkpoint = {
    checkpointId,
    taskId: options.taskId,
    routeId: "main",
    turnId,
    files,
  };
  await repository.writeCheckpoint(checkpoint);
  const events: TaskEvent[] = [
    turnCheckpointedEvent({ checkpointId, routeId: "main", turnId, files }),
    turnPreparedEvent({
      turnId,
      checkpointId,
      routeId: "main",
      role: "assistant",
      prompt: options.prompt,
      parentCheckpointId: checkpointId,
    }),
  ];
  if (options.committed !== false) {
    events.push(turnCommittedEvent({ turnId, checkpointId, routeId: "main" }));
  }
  await repository.append(events);
}

/** Extracts every module specifier imported by the package's TypeScript sources. */
async function inspectPackageImports(packageDir: string): Promise<string[]> {
  const specifiers: string[] = [];
  const importPattern = /(?:from|import)\s*\(?["']([^"']+)["']/g;
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
        continue;
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(entry.name)) continue;
      const text = await fs.readFile(target, "utf8");
      for (const match of text.matchAll(importPattern)) {
        specifiers.push(match[1]!);
      }
    }
  }
  await walk(path.join(repoRoot, packageDir, "src"));
  return specifiers;
}

// ---------------------------------------------------------------------------
// Brief snippet tests (verbatim)
// ---------------------------------------------------------------------------

describe("task CLI adapter (no Electron host)", () => {
  it("runs a baseline task and reviews a hunk through ports", async () => {
    const repo = await createGitFixture({ "a.txt": "committed content\n" });
    const storageDir = await tempDir("ic-cli-store-");
    const taskRuntime = await createTaskCliRuntime({
      storageDir,
      agentWriter: async (task) => {
        // the injected agent seam: a real file write into the task workspace
        await fs.writeFile(path.join(task.workspaceRoot, "a.txt"), "committed content\nagent change\n", "utf8");
      },
    });
    const cli = createTaskCliAdapter({ taskRuntime, output: collectStructuredOutput() });
    const task = await cli.start({ workspaceRoot: repo, mode: "baseline" });
    const hunks = await cli.listHunks(task.taskId, task.activeRouteId);
    await cli.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: hunks[0]!.ref, status: "accepted" });
    expect(await cli.getTask(task.taskId)).toMatchObject({ unreviewedChanges: 0 });
  });

  it("does not import Electron or React", async () => {
    expect(await inspectPackageImports("packages/task-cli")).not.toEqual(expect.arrayContaining(["electron", "react"]));
  });

  // -----------------------------------------------------------------------
  // Closed-loop coverage (brief step 4)
  // -----------------------------------------------------------------------

  it("attributes unknown changes task-owned and external through the real service and log", async () => {
    const workspace = await tempDir("ic-cli-attr-");
    const storageDir = await tempDir("ic-cli-attrstore-");
    const runtime = await createTaskCliRuntime({ storageDir });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({ workspaceRoot: workspace, mode: "baseline" });

    // Middleware-equivalent seeding: the capture middleware would append this
    // when it observes an unknown-source change (see plugin-task middleware).
    const repository = await openTaskRepository(storageDir, task.taskId);
    await repository.append([
      { type: "attributionPending", paths: ["made/one.ts", "made/two.ts"] } as TaskEvent,
    ]);
    const blockedEvents = await repository.list();
    expect(hasUnresolvedAttribution(foldAttributionDecisions(blockedEvents))).toBe(true);

    await cli.attributeUnknown(task.taskId, "made/one.ts", "task-owned");
    await cli.attributeUnknown(task.taskId, "made/two.ts", "external");

    const events = await repository.list();
    const resolved = events.filter((event) => event.type === "attributionResolved");
    expect(resolved).toEqual([
      expect.objectContaining({ path: "made/one.ts", attribution: "task-owned", status: "pending-review" }),
      expect.objectContaining({ path: "made/two.ts", attribution: "external", status: "excluded" }),
    ]);
    // the plugin-task write gate (middleware) is clearable from this state
    expect(hasUnresolvedAttribution(foldAttributionDecisions(events))).toBe(false);
  });

  it("resolveConflict clears the middleware write gate via conflictResolved through the real service", async () => {
    const workspace = await tempDir("ic-cli-conf-");
    const storageDir = await tempDir("ic-cli-confstore-");
    const runtime = await createTaskCliRuntime({ storageDir });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({ workspaceRoot: workspace, mode: "baseline" });

    const repository = await openTaskRepository(storageDir, task.taskId);
    await repository.append([{ type: "attributionConflict", paths: ["clash.ts"] } as TaskEvent]);
    expect(hasUnresolvedAttribution(foldAttributionDecisions(await repository.list()))).toBe(true);

    await cli.resolveConflict({ taskId: task.taskId, routeId: task.activeRouteId, path: "clash.ts", attribution: "task-owned" });

    const events = await repository.list();
    expect(events.at(-1)).toMatchObject({ type: "conflictResolved", path: "clash.ts", attribution: "task-owned" });
    const decisions = foldAttributionDecisions(events);
    expect(hasUnresolvedAttribution(decisions)).toBe(false);
    expect(decisions.find((decision) => decision.path === "clash.ts")?.status).toBe("pending-review");
  });

  it("restore rejects a stale expectedVersion, then reverts the file with the current one", async () => {
    const repo = await createGitFixture({ "a.txt": "committed content\n" });
    const storageDir = await tempDir("ic-cli-restore-");
    const runtime = await createTaskCliRuntime({
      storageDir,
      agentWriter: async (task) => {
        await fs.writeFile(path.join(task.workspaceRoot, "a.txt"), "committed content\nagent change\n", "utf8");
      },
    });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({ workspaceRoot: repo, mode: "baseline" });
    const hunks = await cli.listHunks(task.taskId, task.activeRouteId);
    expect(hunks).toHaveLength(1);

    await expect(
      cli.restore({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: hunks[0]!.ref, expectedVersion: "v0:stale" }),
    ).rejects.toMatchObject({ code: "version-conflict" });
    expect(await fileText(path.join(repo, "a.txt"))).toBe("committed content\nagent change\n");

    const version = (await cli.getTask(task.taskId)).version ?? "";
    await cli.restore({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: hunks[0]!.ref, expectedVersion: version });
    expect(await fileText(path.join(repo, "a.txt"))).toBe("committed content\n");
    const after = await cli.listHunks(task.taskId, task.activeRouteId);
    expect(after.every((hunk) => hunk.status === "restored" || hunk.status === "accepted")).toBe(true);
    expect(await cli.getTask(task.taskId)).toMatchObject({ unreviewedChanges: 0 });
  });

  it("validate gates completion until confirmed, recording a validationOverride event", async () => {
    const workspace = await tempDir("ic-cli-val-");
    const storageDir = await tempDir("ic-cli-valstore-");
    const runtime = await createTaskCliRuntime({
      storageDir,
      validator: async () => ({ success: false, message: "lint errors" }),
    });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({ workspaceRoot: workspace, mode: "baseline" });

    expect(await cli.validate(task.taskId, task.activeRouteId)).toMatchObject({ success: false, message: "lint errors" });
    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: false }))
      .rejects.toMatchObject({ code: "completion-gate" });
    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: true })).resolves.toBeUndefined();

    const repository = await openTaskRepository(storageDir, task.taskId);
    const events = await repository.list();
    expect(events.at(-1)).toMatchObject({ type: "validationOverride", validationResult: { success: false } });
  });

  it("retries a historical assistant turn into an isolated worktree route", async () => {
    const repo = await createGitFixture({ "app.txt": "base\n", "keep.txt": "keep\n" });
    const storageDir = await tempDir("ic-cli-retry-");
    const runtime = await createTaskCliRuntime({ storageDir });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({
      workspaceRoot: repo,
      mode: "isolated",
      sessionId: "session_retry",
    });
    await seedAssistantTurn({
      storageDir,
      taskId: task.taskId,
      files: { "app.txt": "checkpoint one\n" },
      prompt: "original prompt",
    });
    const baseCommit = (await gitExec(task.workspaceRoot, ["rev-parse", "HEAD"])).trim();
    const stateBefore = await cli.getTask(task.taskId);

    const retried = await cli.retryAssistant({
      sessionId: "session_retry",
      taskId: task.taskId,
      sourceRouteId: task.activeRouteId,
      sourceTurnId: "turn_a1",
      routeName: "Retry a1",
    });

    expect(retried.prompt).toBe("original prompt");
    expect(retried.route.parentRouteId).toBe(task.activeRouteId);
    expect(retried.route.workspaceRoot).toBeDefined();
    expect(retried.route.workspaceRoot).not.toBe(task.workspaceRoot);
    expect(await fileText(path.join(retried.route.workspaceRoot!, "app.txt"))).toBe("checkpoint one\n");
    expect((await gitExec(retried.route.workspaceRoot!, ["rev-parse", "HEAD"])).trim()).toBe(baseCommit);
    const routes = await cli.listRoutes(task.taskId);
    expect(routes.map((route) => route.routeId)).toContain(retried.route.routeId);
    // ownership: another session cannot fork this task
    await expect(
      cli.retryAssistant({
        sessionId: "session_other",
        taskId: task.taskId,
        sourceRouteId: task.activeRouteId,
        sourceTurnId: "turn_a1",
        routeName: "hostile fork",
      }),
    ).rejects.toMatchObject({ code: "session-scope" });
    void stateBefore;
  });

  it("a fresh service over the same storage reports recovery warnings, recovers the worktree and applies", async () => {
    const repo = await createGitFixture({ "a.txt": "base\n" });
    const storageDir = await tempDir("ic-cli-restart-");
    const runtime = await createTaskCliRuntime({
      storageDir,
      agentWriter: async (task) => {
        await fs.writeFile(path.join(task.workspaceRoot, "a.txt"), "base\nagent change\n", "utf8");
      },
    });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({ workspaceRoot: repo, mode: "isolated" });
    // a crash left a prepared turn behind (never committed) — recovery warns
    await seedAssistantTurn({
      storageDir,
      taskId: task.taskId,
      files: { "a.txt": "base\nagent change\n" },
      prompt: "interrupted",
      turnId: "turn_crash",
      committed: false,
    });
    const checkpoint = await cli.getCheckpoint(task.taskId, task.baselineCheckpointId);
    expect(checkpoint).not.toBeNull();

    // "restart": a completely fresh runtime + adapter over the SAME storage
    const restarted = createTaskCliAdapter({
      taskRuntime: await createTaskCliRuntime({ storageDir }),
      output: collectStructuredOutput(),
    });
    const warnings = await restarted.recoveryWarnings(task.taskId);
    expect(warnings.some((warning) => warning.includes("turn_crash"))).toBe(true);

    const recovered = await restarted.recover(task.taskId);
    expect(recovered.activeRouteId).toBe(task.activeRouteId);
    // crash semantics: the worktree replays to the route's checkpoint (the
    // uncommitted turn's files are gone, exactly like a crashed session)
    expect(await fileText(path.join(task.workspaceRoot, "a.txt"))).toBe("base\n");

    // the closed loop continues after restart: the agent re-applies its work,
    // then review + final apply run through the fresh service. The crashed
    // prepared turn still blocks COMPLETION (unstable call) — that is the
    // correct post-crash gate — but apply is a route-scoped operation.
    await fs.writeFile(path.join(task.workspaceRoot, "a.txt"), "base\nagent change\n", "utf8");
    const hunks = await restarted.listHunks(task.taskId, task.activeRouteId);
    expect(hunks.length).toBeGreaterThan(0);
    for (const hunk of hunks) {
      await restarted.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: hunk.ref, status: "accepted" });
    }
    await expect(restarted.complete({ taskId: task.taskId, confirmValidationFailure: false }))
      .rejects.toMatchObject({ code: "completion-gate" });
    const applied = await restarted.applyAccepted(task.taskId, task.activeRouteId);
    expect(applied.conflicts).toEqual([]);
    expect(await fileText(path.join(repo, "a.txt"))).toBe("base\nagent change\n");
    // the Git index is never touched by apply
    expect(await gitExec(repo, ["diff", "--cached"])).toBe("");
  });

  it("final apply writes only accepted content into the original workspace", async () => {
    const repo = await createGitFixture({ "a.txt": "base\n", "untouched.txt": "stay\n" });
    const storageDir = await tempDir("ic-cli-apply-");
    const runtime = await createTaskCliRuntime({
      storageDir,
      agentWriter: async (task) => {
        await fs.writeFile(path.join(task.workspaceRoot, "a.txt"), "base\naccepted change\n", "utf8");
        await fs.writeFile(path.join(task.workspaceRoot, "new.txt"), "new file\n", "utf8");
        await fs.writeFile(path.join(task.workspaceRoot, "rejected.txt"), "rejected\n", "utf8");
      },
    });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({ workspaceRoot: repo, mode: "isolated" });

    const hunks = await cli.listHunks(task.taskId, task.activeRouteId);
    expect(hunks.map((hunk) => hunk.path).sort()).toEqual(["a.txt", "new.txt", "rejected.txt"]);
    for (const hunk of hunks) {
      await cli.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: hunk.ref, status: "accepted" });
    }
    // the rejected change is restored (reverted in the task worktree) before apply
    const rejectedHunk = hunks.find((hunk) => hunk.path === "rejected.txt")!;
    const version = (await cli.getTask(task.taskId)).version ?? "";
    await cli.restore({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: rejectedHunk.ref, expectedVersion: version });
    expect(await fileText(path.join(task.workspaceRoot, "rejected.txt"))).toBeNull();

    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: false })).resolves.toBeUndefined();
    const applied = await cli.applyAccepted(task.taskId, task.activeRouteId);
    expect(applied.conflicts).toEqual([]);
    expect(await fileText(path.join(repo, "a.txt"))).toBe("base\naccepted change\n");
    expect(await fileText(path.join(repo, "new.txt"))).toBe("new file\n");
    expect(await fileText(path.join(repo, "rejected.txt"))).toBeNull(); // restored never lands
    expect(await fileText(path.join(repo, "untouched.txt"))).toBe("stay\n");
    expect(await gitExec(repo, ["diff", "--cached"])).toBe("");
  });

  it("serializes recover and delete against an in-flight leased mutation on the same task", async () => {
    const repo = await createGitFixture({ "a.txt": "base\n" });
    const storageDir = await tempDir("ic-cli-del-");
    const runtime = await createTaskCliRuntime({ storageDir, lockTimeoutMs: 1_500 });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({ workspaceRoot: repo, mode: "isolated" });

    // Hold the task lease exactly the way a service mutation does: recover and
    // delete must be serialized behind it (bounded lock-timeout), never run
    // concurrently with an in-flight mutation.
    const owner = { taskId: task.taskId, routeId: task.activeRouteId };
    const taskLease = await runtime.locks.acquireTaskLease(task.taskId, owner);
    try {
      await expect(cli.recover(task.taskId)).rejects.toMatchObject({ code: "lock-timeout" });
      await expect(cli.delete(task.taskId)).rejects.toMatchObject({ code: "lock-timeout" });
      // nothing was torn down while the lease was held
      expect(await cli.getTask(task.taskId)).toMatchObject({ taskId: task.taskId });
    } finally {
      await taskLease[Symbol.asyncDispose]();
    }

    await expect(cli.recover(task.taskId)).resolves.toMatchObject({ taskId: task.taskId });
    await expect(cli.delete(task.taskId)).resolves.toBeUndefined();
    await expect(cli.getTask(task.taskId)).rejects.toMatchObject({ code: "task-not-found" });
    await expect(fs.access(task.workspaceRoot)).rejects.toThrow();
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Two REAL processes competing for the workspace lock (brief step 4)
// ---------------------------------------------------------------------------

/** Spawns a real TS child (Node type stripping) speaking the JSON-line protocol. */
function spawnChild(scriptName: string, args: string[]) {
  const child = spawn(process.execPath, [path.join(here, scriptName), ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: Array<Record<string, unknown>> = [];
  let stderr = "";
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          events.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // non-JSON child chatter is ignored
        }
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  return {
    pid: child.pid!,
    events,
    exited,
    send(command: Record<string, unknown>): void {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    },
    async nextEvent(timeoutMs = 20000): Promise<Record<string, unknown>> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const next = events.shift();
        if (next !== undefined) return next;
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for child event; stderr so far: ${stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    async noEventFor(ms: number): Promise<boolean> {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return events.length === 0;
    },
    async killTree(): Promise<void> {
      if (child.exitCode !== null) return;
      if (process.platform === "win32") {
        await execFileAsync("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
      } else {
        child.kill("SIGKILL");
      }
      await exited;
    },
    async endGracefully(): Promise<void> {
      this.send({ cmd: "exit" });
      await exited;
    },
  };
}

async function waitForEvent(
  child: ReturnType<typeof spawnChild>,
  event: string,
  timeoutMs = 20000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let index = 0; index < child.events.length; index += 1) {
      const queued = child.events[index]!;
      if (queued.event === event) {
        child.events.splice(0, index + 1);
        return queued;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for "${event}" from child ${child.pid}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("two real processes compete for the workspace lock", () => {
  it("serializes Electron-style command-service mutations and recovers a killed holder", async () => {
    const workspace = await tempDir("ic-cli-lock-");
    const storageDir = await tempDir("ic-cli-lockstore-");
    const runtime = await createTaskCliRuntime({ storageDir, lockTimeoutMs: 60_000 });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({ workspaceRoot: workspace, mode: "baseline" });

    const a = spawnChild("workspace-lock-service.child.ts", [
      storageDir, task.taskId, task.activeRouteId,
      await runtime.canonicalRouteKey(task.taskId, task.activeRouteId),
    ]);
    const b = spawnChild("workspace-lock-service.child.ts", [
      storageDir, task.taskId, task.activeRouteId,
      await runtime.canonicalRouteKey(task.taskId, task.activeRouteId),
    ]);
    try {
      expect((await a.nextEvent()).event).toBe("ready");
      expect((await b.nextEvent()).event).toBe("ready");

      // both children race for the workspace lease through the SAME service path
      a.send({ cmd: "hold" });
      b.send({ cmd: "hold" });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const held = [a, b].flatMap((proc) => proc.events.filter((event) => event.event === "held"));
      expect(held).toHaveLength(1);

      const winner = a.events.some((event) => event.event === "held") ? a : b;
      const loser = winner === a ? b : a;
      // while the winner holds the lease, the loser stays blocked
      expect(await loser.noEventFor(600)).toBe(true);

      // a service mutation from the PARENT process is blocked by the child's lease
      const parentMutation = cli.switchRoute(task.taskId, task.activeRouteId);
      const raceOutcome = await Promise.race([
        parentMutation.then(() => "done"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 800)),
      ]);
      expect(raceOutcome).toBe("blocked");

      winner.send({ cmd: "release" });
      expect((await waitForEvent(winner, "released")).event).toBe("released");
      // the loser acquires as soon as the lease frees
      expect((await waitForEvent(loser, "held")).event).toBe("held");
      loser.send({ cmd: "release" });
      await waitForEvent(loser, "released");
      await parentMutation; // unblocked once every holder released

      // kill test: the winner holds again and dies (taskkill /T /F) — the
      // parent's service mutation recovers the stale lease and proceeds
      winner.send({ cmd: "hold" });
      await waitForEvent(winner, "held");
      await winner.killTree();
      expect(await winner.exited).not.toBe(0);
      await expect(cli.switchRoute(task.taskId, task.activeRouteId)).resolves.toBeDefined();
    } finally {
      await a.endGracefully();
      await b.endGracefully();
    }
  }, 120_000);

  it("serializes the final apply's write into the ORIGINAL workspace across processes", async () => {
    const repo = await createGitFixture({ "a.txt": "base\n" });
    const storageDir = await tempDir("ic-cli-applylock-");
    const runtime = await createTaskCliRuntime({
      storageDir,
      lockTimeoutMs: 1_500,
      agentWriter: async (task) => {
        await fs.writeFile(path.join(task.workspaceRoot, "a.txt"), "base\nagent change\n", "utf8");
      },
    });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
    const task = await cli.start({ workspaceRoot: repo, mode: "isolated" });
    for (const hunk of await cli.listHunks(task.taskId, task.activeRouteId)) {
      await cli.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: hunk.ref, status: "accepted" });
    }
    await cli.complete({ taskId: task.taskId, confirmValidationFailure: false });

    // A second process holds the lease keyed on the ORIGINAL user workspace —
    // the exact key isolated apply must take before writing into it.
    const { canonicalWorkspaceKey } = await import("@innocencecode/task-workspace");
    const contender = spawnChild("workspace-lock-service.child.ts", [
      storageDir, task.taskId, task.activeRouteId,
      await canonicalWorkspaceKey(repo),
    ]);
    try {
      expect((await contender.nextEvent()).event).toBe("ready");
      contender.send({ cmd: "hold" });
      expect((await contender.nextEvent()).event).toBe("held");

      // apply is BLOCKED (bounded) while the original workspace is leased
      await expect(cli.applyAccepted(task.taskId, task.activeRouteId))
        .rejects.toMatchObject({ code: "lock-timeout" });
      expect(await fileText(path.join(repo, "a.txt"))).toBe("base\n"); // nothing written

      contender.send({ cmd: "release" });
      expect((await waitForEvent(contender, "released")).event).toBe("released");

      const applied = await cli.applyAccepted(task.taskId, task.activeRouteId);
      expect(applied.conflicts).toEqual([]);
      expect(await fileText(path.join(repo, "a.txt"))).toBe("base\nagent change\n");
    } finally {
      await contender.endGracefully();
    }
  }, 120_000);
});
