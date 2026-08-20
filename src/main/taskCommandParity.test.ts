// Electron ↔ CLI adapter parity (Task 13): the Electron command service
// (bridge-backed, src/main/taskCommandService) and the CLI adapter
// (@innocencecode/task-cli) expose the SAME command semantics because both
// only delegate to task-core's one TaskCommandService. Three layers of proof,
// all over REAL storage:
//
//   1. SURFACE parity — a documented method-name mapping covering the fixed
//      19-method set plus the escape hatches; each adapter must expose
//      EXACTLY the mapped names (any surface drift fails here).
//   2. ERROR-CODE parity — the mapped methods reject with identical
//      TaskCommandError codes (task/route/version/hunk/gate) on both sides.
//   3. BEHAVIOR parity — both adapters drive the SAME task: identical hunks,
//      and mutations from either side are visible to the other.
//
// The service-level contract itself lives in
// packages/task-core/tests/command-service-contract.test.ts (host-free).
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectStructuredOutput,
  createTaskCliAdapter,
  createTaskCliRuntime,
} from "@innocencecode/task-cli";
import { createTaskRuntimeBridge } from "./taskRuntimeBridge";
import { createTaskCommandService, type TaskCommandService } from "./taskCommandService";
import type { TaskCliAdapter } from "@innocencecode/task-cli";

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

async function createGitFixture(files: Record<string, string>): Promise<string> {
  const root = await tempDir("ic-parity-git-");
  const git = (args: string[]) => execFileAsync("git", args, { cwd: root, windowsHide: true });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Parity Fixture"]);
  await git(["config", "user.email", "parity@example.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), content, "utf8");
  }
  await git(["add", "-A"]);
  await git(["commit", "-m", "fixture base"]);
  return root;
}

// ---------------------------------------------------------------------------
// 1. The documented adapter surface mapping (fixed 19 + escape hatches)
// ---------------------------------------------------------------------------

/**
 * service  — the task-core TaskCommandService method.
 * electron — the TaskCommandPort method(s) it maps onto (empty = intentionally
 *            host-side: get/recoveryWarnings are read-only handler
 *            computations; delete is the bridge's).
 * cli      — the CLI adapter method(s) (empty = host escape hatch the CLI
 *            surface does not expose).
 */
const PARITY_MAP = [
  { service: "start", electron: ["startTask"], cli: ["start"], note: "Electron start = bridge-backed find-or-start bound to the session" },
  { service: "get", electron: [], cli: ["getTask"], note: "Electron getTask is a read-only handler computation" },
  { service: "getChanges", electron: [], cli: ["getChanges"], note: "change cards are renderer-derived in Electron today" },
  { service: "getCheckpoint", electron: [], cli: ["getCheckpoint"], note: "checkpoint reads are host-side in Electron" },
  { service: "listRoutes", electron: ["listRoutes"], cli: ["listRoutes"], note: "" },
  { service: "switchRoute", electron: ["switchRoute"], cli: ["switchRoute"], note: "" },
  { service: "forkFromUser", electron: ["forkRoute", "editUserMessage"], cli: ["forkFromUser"], note: "forkRoute carries mode edit-user" },
  { service: "retryAssistant", electron: ["retryAssistant", "forkRoute"], cli: ["retryAssistant"], note: "forkRoute carries mode retry-assistant" },
  { service: "listHunks", electron: ["getHunks"], cli: ["listHunks"], note: "" },
  { service: "review", electron: ["reviewHunk"], cli: ["review"], note: "" },
  { service: "restore", electron: ["restoreHunk"], cli: ["restore"], note: "" },
  { service: "attributeUnknown", electron: [], cli: ["attributeUnknown"], note: "Electron resolves attribution through renderer flows" },
  { service: "resolveConflict", electron: ["resolveConflict"], cli: ["resolveConflict"], note: "" },
  { service: "validate", electron: ["validate"], cli: ["validate"], note: "" },
  { service: "complete", electron: ["complete"], cli: ["complete"], note: "" },
  { service: "applyAccepted", electron: ["applyAccepted", "preflightApply"], cli: ["applyAccepted"], note: "preflightApply = dry-run" },
  { service: "recover", electron: ["recoverTask"], cli: ["recover"], note: "" },
  { service: "delete", electron: [], cli: ["delete"], note: "Electron deletion is bridge-hosted" },
  { service: "recoveryWarnings", electron: [], cli: ["recoveryWarnings"], note: "handler computes warnings from the log" },
  { service: "createCheckpoint (hatch)", electron: ["createCheckpoint"], cli: [], note: "Electron checkpoint channel" },
  { service: "changeStatus (hatch)", electron: ["changeTaskStatus"], cli: [], note: "Electron status channel" },
  { service: "append (hatch)", electron: ["appendEvent"], cli: [], note: "Electron raw-append channel" },
] as const;

/** Adapter methods outside the mapping (documented extras). */
const ELECTRON_EXTRAS = ["resolveGitBranch"];
const CLI_EXTRAS = ["renderTask", "renderReview", "renderRouteList"];

function functionKeys(target: object): string[] {
  return Object.keys(target).filter((key) => typeof (target as Record<string, unknown>)[key] === "function").sort();
}

function expectSurfaceParity(electron: TaskCommandService, cli: TaskCliAdapter): void {
  const expectedElectron = new Set<string>(ELECTRON_EXTRAS);
  const expectedCli = new Set<string>(CLI_EXTRAS);
  for (const entry of PARITY_MAP) {
    for (const name of entry.electron) {
      expectedElectron.add(name);
      expect(typeof (electron as unknown as Record<string, unknown>)[name], `electron.${name} (${entry.service})`).toBe("function");
    }
    for (const name of entry.cli) {
      expectedCli.add(name);
      expect(typeof (cli as unknown as Record<string, unknown>)[name], `cli.${name} (${entry.service})`).toBe("function");
    }
  }
  // exact surface equality: any drift (added OR removed command) fails here
  expect(functionKeys(electron)).toEqual([...expectedElectron].sort());
  expect(functionKeys(cli)).toEqual([...expectedCli].sort());
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "(resolved)";
  } catch (error) {
    return (error as { code?: string }).code ?? `(no code: ${String(error)})`;
  }
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe("Electron ↔ CLI command adapter parity", () => {
  it("exposes exactly the mapped command surfaces (full 19 + escape hatches)", async () => {
    const storageDir = await tempDir("ic-parity-surface-");
    const bridge = createTaskRuntimeBridge({ taskStorageDir: storageDir, onTaskEvent: () => {} });
    cleanups.push(() => bridge.disposeAll());
    const electron = createTaskCommandService({ bridge, taskStorageDir: storageDir, resolveSessionRoot: async () => undefined, onEvent: () => {} });
    const cli = createTaskCliAdapter({
      taskRuntime: await createTaskCliRuntime({ storageDir }),
      output: collectStructuredOutput(),
    });
    expectSurfaceParity(electron, cli);
  });

  it("rejects with identical error codes across the mapped methods, and applies identically", async () => {
    const repo = await createGitFixture({ "a.txt": "committed\n", "b.txt": "committed b\n" });
    const storageDir = await tempDir("ic-parity-store-");

    const cliRuntime = await createTaskCliRuntime({
      storageDir,
      agentWriter: async (task) => {
        await fs.writeFile(path.join(task.workspaceRoot, "a.txt"), "committed\nagent change\n", "utf8");
        await fs.writeFile(path.join(task.workspaceRoot, "b.txt"), "committed b\nagent change b\n", "utf8");
      },
    });
    const cli = createTaskCliAdapter({ taskRuntime: cliRuntime, output: collectStructuredOutput() });

    const bridge = createTaskRuntimeBridge({
      taskStorageDir: storageDir,
      onTaskEvent: () => {},
    });
    cleanups.push(() => bridge.disposeAll());
    const electron = createTaskCommandService({ bridge, taskStorageDir: storageDir, resolveSessionRoot: async () => undefined, onEvent: () => {} });

    const task = await cli.start({ workspaceRoot: repo, mode: "baseline" });
    const hunks = await cli.listHunks(task.taskId, task.activeRouteId);
    expect(hunks).toHaveLength(2);
    const ghostRef = "not-a-hunk-ref";

    // -- error-code parity matrix over the mapped methods -------------------
    // task-not-found
    for (const [electronCall, cliCall] of [
      [() => electron.listRoutes("nope"), () => cli.listRoutes("nope")],
      [() => electron.getHunks("nope", "main"), () => cli.listHunks("nope", "main")],
      [() => electron.switchRoute("nope", "main"), () => cli.switchRoute("nope", "main")],
      [() => electron.validate("nope", "main"), () => cli.validate("nope", "main")],
      [() => electron.complete({ taskId: "nope", confirmValidationFailure: false }), () => cli.complete({ taskId: "nope", confirmValidationFailure: false })],
      [() => electron.applyAccepted("nope", "main"), () => cli.applyAccepted("nope", "main")],
      [() => electron.recoverTask("nope"), () => cli.recover("nope")],
      [() => electron.resolveConflict("nope", "main", "x.ts", "external"), () => cli.resolveConflict({ taskId: "nope", routeId: "main", path: "x.ts", attribution: "external" })],
    ] as const) {
      expect(await codeOf(electronCall)).toBe(await codeOf(cliCall));
      expect(await codeOf(cliCall)).toBe("task-not-found");
    }
    // route-not-found
    for (const [electronCall, cliCall] of [
      [() => electron.getHunks(task.taskId, "ghost"), () => cli.listHunks(task.taskId, "ghost")],
      [() => electron.switchRoute(task.taskId, "ghost"), () => cli.switchRoute(task.taskId, "ghost")],
      [() => electron.validate(task.taskId, "ghost"), () => cli.validate(task.taskId, "ghost")],
      [() => electron.applyAccepted(task.taskId, "ghost"), () => cli.applyAccepted(task.taskId, "ghost")],
    ] as const) {
      expect(await codeOf(electronCall)).toBe("route-not-found");
      expect(await codeOf(electronCall)).toBe(await codeOf(cliCall));
    }
    // version-conflict and hunk-not-found through review
    const staleVersion = "v0:stale";
    expect(await codeOf(() => electron.reviewHunk(task.taskId, task.activeRouteId, hunks[0]!.ref, "accepted", staleVersion))).toBe("version-conflict");
    expect(await codeOf(() => cli.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: hunks[0]!.ref, status: "accepted", expectedVersion: staleVersion }))).toBe("version-conflict");
    expect(await codeOf(() => electron.reviewHunk(task.taskId, task.activeRouteId, ghostRef, "accepted"))).toBe("hunk-not-found");
    expect(await codeOf(() => cli.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: ghostRef, status: "accepted" }))).toBe("hunk-not-found");
    // restore enforces the same expectedVersion CAS (the renderer's token
    // flows through the Electron handler to the service — M3 fold-in).
    expect(await codeOf(() => electron.restoreHunk(task.taskId, task.activeRouteId, hunks[0]!.ref, staleVersion))).toBe("version-conflict");
    expect(await codeOf(() => cli.restore({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: hunks[0]!.ref, expectedVersion: staleVersion }))).toBe("version-conflict");
    // completion gate with unreviewed hunks
    expect(await codeOf(() => electron.complete({ taskId: task.taskId, confirmValidationFailure: false }))).toBe("completion-gate");
    expect(await codeOf(() => cli.complete({ taskId: task.taskId, confirmValidationFailure: false }))).toBe("completion-gate");

    // -- identical hunks and cross-visible mutations ------------------------
    const electronHunks = await electron.getHunks(task.taskId, task.activeRouteId);
    expect(electronHunks.map((hunk) => [hunk.ref, hunk.path, hunk.status])).toEqual(
      hunks.map((hunk) => [hunk.ref, hunk.path, hunk.status]),
    );

    await cli.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: hunks[0]!.ref, status: "accepted" });
    await electron.reviewHunk(task.taskId, task.activeRouteId, hunks[1]!.ref, "accepted");
    expect((await electron.getHunks(task.taskId, task.activeRouteId)).every((hunk) => hunk.status === "accepted")).toBe(true);
    expect((await cli.listHunks(task.taskId, task.activeRouteId)).every((hunk) => hunk.status === "accepted")).toBe(true);

    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: false })).resolves.toBeUndefined();

    // -- apply conflict + clean-apply parity (isolated task: the apply target
    //    is the ORIGINAL workspace, so an external drift there conflicts
    //    without changing the task's own reviewed hunks; the same runtime
    //    agentWriter seam writes inside the new worktree) --------------------
    // reset the baseline task's workspace change first so the isolated task's
    // checkpoint starts from the committed content
    await fs.writeFile(path.join(repo, "a.txt"), "committed\n", "utf8");
    const isolated = await cli.start({ workspaceRoot: repo, mode: "isolated" });
    for (const hunk of await cli.listHunks(isolated.taskId, isolated.activeRouteId)) {
      await cli.review({ taskId: isolated.taskId, routeId: isolated.activeRouteId, hunkRef: hunk.ref, status: "accepted" });
    }
    await expect(cli.complete({ taskId: isolated.taskId, confirmValidationFailure: false })).resolves.toBeUndefined();

    await fs.writeFile(path.join(repo, "a.txt"), "committed\nexternal drift\n", "utf8");
    const electronConflict = await electron.applyAccepted(isolated.taskId, isolated.activeRouteId);
    const cliConflict = await cli.applyAccepted(isolated.taskId, isolated.activeRouteId);
    expect(electronConflict.conflicts.map((conflict) => conflict.path)).toEqual(["a.txt"]);
    expect(cliConflict.conflicts.map((conflict) => conflict.path)).toEqual(["a.txt"]);
    expect(await fileText(path.join(repo, "a.txt"))).toBe("committed\nexternal drift\n"); // untouched

    await fs.writeFile(path.join(repo, "a.txt"), "committed\n", "utf8");
    const applied = await electron.applyAccepted(isolated.taskId, isolated.activeRouteId);
    expect(applied.conflicts).toEqual([]);
    expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toBe("committed\nagent change\n");
  }, 180_000);
});

async function fileText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}
