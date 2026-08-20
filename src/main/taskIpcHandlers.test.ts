// Tests for TaskIpcHandlers — task/review/route IPC surface and completion
// gate.  No Electron dependency: the bridge, command port, and route-lock
// resolver are all faked.
import { describe, expect, it, beforeEach } from "vitest";
import {
  taskCreatedEvent,
  turnPreparedEvent,
  type TaskEvent,
  type Hunk,
} from "@innocencecode/task-core";
import type { TaskHandle, TaskRuntimeBridge } from "./taskRuntimeBridge";
import { TaskIpcHandlers, type TaskCommandPort } from "./taskIpcHandlers";

// ---------------------------------------------------------------------------
// Fake event helpers (attribution events have no factory — create raw)
// ---------------------------------------------------------------------------

function fakeCreatedEvent(overrides?: Partial<{ taskId: string; sessionId: string; routeId: string }>): TaskEvent {
  return taskCreatedEvent({
    taskId: overrides?.taskId ?? "t1",
    sessionId: overrides?.sessionId ?? "s1",
    routeId: overrides?.routeId ?? "main",
    workspaceRoot: "/workspace",
    workspaceKind: "git",
    mode: "baseline",
    baselineCheckpointId: "ckpt_base",
  });
}

function fakeTurnPrepared(turnId: string, routeId: string, checkpointId: string): TaskEvent {
  return turnPreparedEvent({ turnId, checkpointId, routeId });
}

function fakeAttributionConflict(paths: string[]): TaskEvent {
  return {
    type: "attributionConflict",
    eventId: `evt_conflict_${Date.now()}`,
    at: new Date().toISOString(),
    paths,
  } as TaskEvent;
}

// ---------------------------------------------------------------------------
// Fake bridge + command port
// ---------------------------------------------------------------------------

interface FakeBridgeState {
  handle: TaskHandle | undefined;
  events: TaskEvent[];
}

function fakeBridge(state: FakeBridgeState): TaskRuntimeBridge {
  return {
    get: () => state.handle,
    listTasks: () => (state.handle ? [state.handle.taskId] : []),
    listEvents: async () => state.events,
    start: async () => state.handle!,
    onTaskEvent: () => () => {},
    releaseTask: async () => {},
    deleteTask: async () => {},
    disposeAll: async () => {},
  } as unknown as TaskRuntimeBridge;
}

function fakeHandle(overrides?: Partial<TaskHandle>): TaskHandle {
  return {
    taskId: "t1",
    sessionId: "s1",
    routeId: "main",
    mode: "baseline",
    workspaceKind: "git",
    workspaceRoot: "/workspace",
    userWorkspaceRoot: "/user-workspace",
    baselineCheckpointId: "ckpt_base",
    port: {} as never,
    ...overrides,
  };
}

/** Minimal command port; hunks are mutable for review tests and complete()
 * mirrors the service's gate over the fake bridge state (the REAL gate is
 * covered by task-core's contract tests and the CLI integration suite). */
class FakeCommandPort implements TaskCommandPort {
  hunks: Hunk[] = [];
  constructor(private readonly bridgeState: () => FakeBridgeState) {}
  getHunks = async (_taskId: string, _routeId: string) => this.hunks;
  listRoutes = async (_taskId: string) => [
    { routeId: "main", parentRouteId: null, forkTurnId: null, checkpointId: "ckpt_base", workspaceKind: "git" },
  ];
  switchRoute = async (_taskId: string, routeId: string) => ({
    routeId,
    parentRouteId: null,
    forkTurnId: null,
    checkpointId: "ckpt",
    workspaceKind: "git",
  });
  forkRoute: TaskCommandPort["forkRoute"] = async (request) => ({
    routeId: "fork_1",
    parentRouteId: request.sourceRouteId,
    forkTurnId: request.sourceTurnId,
    checkpointId: "ckpt_fork",
    workspaceKind: "git",
    workspaceRoot: "/worktrees/fork_1",
    prompt: "resolved fork prompt",
  });
  reviewHunk = async (_taskId: string, _routeId: string, _hunkRef: string, _status: "accepted" | "restored", _expectedVersion?: string) => {};
  restoreHunk = async () => {};
  applyAccepted: TaskCommandPort["applyAccepted"] = async () => ({ applied: [], conflicts: [] });
  preflightApply: TaskCommandPort["preflightApply"] = async () => ({ status: "clean" as const });
  resolveConflict = async () => {};
  editUserMessage = async () => ({ turnId: "turn_new" });
  retryAssistant = async () => ({ turnId: "turn_retry" });
  createCheckpoint = async (_taskId: string, _routeId: string) => ({
    checkpointId: "ckpt_new",
  });
  changeTaskStatus = async () => {};
  complete: TaskCommandPort["complete"] = async (request) => {
    const events = this.bridgeState().events;
    const conflicted = new Set<string>();
    const resolved = new Set<string>();
    for (const event of events) {
      if (event.type === "attributionConflict") {
        for (const path of event.paths) conflicted.add(path);
      } else if (event.type === "attributionResolved" || event.type === "conflictResolved") {
        resolved.add(event.path);
      }
    }
    const unresolvedConflicts = [...conflicted].filter((path) => !resolved.has(path)).length;
    const unstableCalls = events.filter((event) => event.type === "turnPrepared").length;
    const unreviewedChanges = this.hunks.filter(
      (hunk) => hunk.status !== "accepted" && hunk.status !== "restored",
    ).length;
    const validation = await this.validate(request.taskId, "main");
    let gateValidation: import("../shared/taskIpc").ValidationResult | null = validation;
    if (request.confirmValidationFailure && !validation.success) {
      gateValidation = null;
      await this.appendEvent(request.taskId, {
        type: "validationOverride",
        validationResult: validation,
      } as unknown as TaskEvent);
    }
    if (
      unresolvedConflicts > 0 ||
      unstableCalls > 0 ||
      unreviewedChanges > 0 ||
      (gateValidation !== null && !gateValidation.success)
    ) {
      throw Object.assign(new Error("completion gate"), {
        gate: { runningTools: 0, unresolvedConflicts, unstableCalls, unreviewedChanges, validation: gateValidation },
      });
    }
  };
  validate = async (_taskId?: string, _routeId?: string) => ({ success: true });
  startTaskCalls: Array<{ sessionId: string; mode?: "baseline" | "isolated"; create?: boolean }> = [];
  startTask: TaskCommandPort["startTask"] = async (request) => {
    this.startTaskCalls.push(request);
    return request.create !== false && request.sessionId === "s1"
      ? {
          taskId: "t1",
          sessionId: "s1",
          status: "ready",
          activeRouteId: "main",
          mode: request.mode ?? "baseline",
          workspaceKind: "git",
          version: "evt_1",
          gitBranch: null,
          routeId: "main",
        }
      : null;
  };
  recoverTask = async (taskId: string) => ({
    taskId,
    sessionId: "s1",
    status: "ready",
    activeRouteId: "main",
    mode: "baseline",
    workspaceKind: "git",
    gitBranch: null,
  });
  appendEvent = async (_taskId: string, _event: TaskEvent) => {};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TaskIpcHandlers", () => {
  let commandPort: FakeCommandPort;
  let bridgeState: FakeBridgeState;
  let handlers: TaskIpcHandlers;

  function buildHandlers(): TaskIpcHandlers {
    return new TaskIpcHandlers({
      bridge: fakeBridge(bridgeState),
      commandPort,
    });
  }

  beforeEach(() => {
    commandPort = new FakeCommandPort(() => bridgeState);
    bridgeState = {
      handle: fakeHandle(),
      events: [fakeCreatedEvent()],
    };
    handlers = buildHandlers();
  });

  // --- Brief snippet tests (verbatim) ---

  it("rejects a hunk from another task", async () => {
    await expect(
      handlers.review({
        taskId: "t1",
        routeId: "main",
        hunkRef: "t2:h1",
        status: "accepted",
        expectedVersion: "v1:evt",
      }),
    ).rejects.toThrow("hunk scope");
  });

  it("blocks completion with unresolved conflict or unstable call", async () => {
    // Set up task with an unresolved attribution conflict
    bridgeState.events = [
      fakeCreatedEvent({ taskId: "t1" }),
      fakeAttributionConflict(["conflict.ts"]),
    ];
    handlers = buildHandlers();
    await expect(
      handlers.complete({ taskId: "t1", confirmValidationFailure: false }),
    ).rejects.toThrow("completion gate");
  });

  // --- Task/route resolution ---

  it("start delegates to the command port's find-or-start (task:start channel)", async () => {
    const created = await handlers.start({ sessionId: "s1" });
    expect(created).toMatchObject({ taskId: "t1", sessionId: "s1", routeId: "main" });
    expect(commandPort.startTaskCalls).toEqual([{ sessionId: "s1", mode: "baseline", create: true }]);

    const probe = await handlers.start({ sessionId: "other", mode: "isolated", create: false });
    expect(probe).toBeNull();
    expect(commandPort.startTaskCalls.at(-1)).toEqual({
      sessionId: "other",
      mode: "isolated",
      create: false,
    });
  });

  it("start rejects an empty sessionId", async () => {
    await expect(handlers.start({ sessionId: "" })).rejects.toThrow("start requires a sessionId");
  });

  it("getTask returns task state DTO for existing task", async () => {
    const result = await handlers.getTask({ taskId: "t1" });
    expect(result.taskId).toBe("t1");
    expect(result.status).toBe("ready");
  });

  it("getTask throws for unknown task", async () => {
    bridgeState.handle = undefined;
    handlers = buildHandlers();
    await expect(handlers.getTask({ taskId: "nonexistent" })).rejects.toThrow(
      "task not found",
    );
  });

  it("listRoutes returns route DTOs for existing task", async () => {
    const result = await handlers.listRoutes({ taskId: "t1" });
    expect(result.routes).toBeDefined();
    expect(Array.isArray(result.routes)).toBe(true);
  });

  it("switchRoute throws for route not in task", async () => {
    await expect(
      handlers.switchRoute({ taskId: "t1", routeId: "nonexistent_route" }),
    ).rejects.toThrow("route");
  });

  // --- Hunk scope ---

  it("review accepts hunk from same task", async () => {
    commandPort.hunks = [
      { ref: "t1:h1", path: "a.ts", before: "", after: "x", context: [], status: "pending" },
    ];
    await expect(
      handlers.review({
        taskId: "t1",
        routeId: "main",
        hunkRef: "t1:h1",
        status: "accepted",
        expectedVersion: "v1:evt",
      }),
    ).resolves.toBeUndefined();
  });

  // --- Completion gate ---

  it("complete succeeds when task is clean", async () => {
    // Minimal clean task: only taskCreated, no pending work
    await expect(
      handlers.complete({ taskId: "t1", confirmValidationFailure: false }),
    ).resolves.toBeUndefined();
  });

  it("complete blocks when hunks are unreviewed", async () => {
    commandPort.hunks = [
      {
        ref: "t1:h1",
        path: "a.ts",
        before: "",
        after: "x",
        context: [],
        status: "pending",
      },
    ];
    await expect(
      handlers.complete({ taskId: "t1", confirmValidationFailure: false }),
    ).rejects.toThrow("completion gate");
  });

  it("complete blocks when there are attribution conflicts", async () => {
    bridgeState.events = [
      fakeCreatedEvent({ taskId: "t1" }),
      fakeAttributionConflict(["foo.ts"]),
    ];
    handlers = buildHandlers();
    await expect(
      handlers.complete({ taskId: "t1", confirmValidationFailure: false }),
    ).rejects.toThrow("completion gate");
  });

  it("complete blocks when there are prepared-but-uncommitted turns", async () => {
    bridgeState.events = [
      fakeCreatedEvent({ taskId: "t1" }),
      fakeTurnPrepared("turn_1", "main", "ckpt_1"),
    ];
    handlers = buildHandlers();
    await expect(
      handlers.complete({ taskId: "t1", confirmValidationFailure: false }),
    ).rejects.toThrow("completion gate");
  });

  it("complete blocks on validation failure without confirmation", async () => {
    commandPort.validate = async () => ({
      success: false,
      message: "lint errors",
    });
    await expect(
      handlers.complete({ taskId: "t1", confirmValidationFailure: false }),
    ).rejects.toThrow("completion gate");
  });

  it("complete proceeds when confirmValidationFailure is true despite validation failure", async () => {
    commandPort.validate = async () => ({
      success: false,
      message: "lint errors",
    });
    // Should not throw — confirmation overrides validation failure
    await expect(
      handlers.complete({ taskId: "t1", confirmValidationFailure: true }),
    ).resolves.toBeUndefined();
  });

  // --- applyAccepted preflight ---

  it("applyAccepted returns ConflictDto on apply conflict", async () => {
    commandPort.applyAccepted = async () => ({
      applied: [],
      conflicts: [{ path: "a.ts", reason: "modified" }],
    });
    const result = await handlers.applyAccepted({ taskId: "t1", routeId: "main" });
    expect(result.status).toBe("conflict");
    expect(result.conflicts).toBeDefined();
  });

  it("applyAccepted applies when the service reports no conflicts", async () => {
    commandPort.applyAccepted = async () => ({ applied: ["a.ts"], conflicts: [] });
    const result = await handlers.applyAccepted({
      taskId: "t1",
      routeId: "main",
    });
    expect(result.status).toBe("applied");
  });

  // --- forkRoute ---

  const forkRequest = () => ({
    sessionId: "s1",
    taskId: "t1",
    sourceRouteId: "main",
    sourceTurnId: "a2",
    mode: "retry-assistant" as const,
    routeName: "Retry a2",
  });

  it("forkRoute returns the isolated route DTO with the resolved prompt for the renderer", async () => {
    const result = await handlers.forkRoute(forkRequest());
    expect(result).toMatchObject({
      routeId: "fork_1",
      workspaceRoot: "/worktrees/fork_1",
      prompt: "resolved fork prompt",
    });
  });

  it("forkRoute rejects when task workspace is not git", async () => {
    bridgeState.handle = fakeHandle({ workspaceKind: "snapshot" });
    handlers = buildHandlers();
    await expect(handlers.forkRoute(forkRequest())).rejects.toThrow("Git repository required");
  });

  it("forkRoute rejects a renderer request from another session", async () => {
    await expect(handlers.forkRoute({ ...forkRequest(), sessionId: "other" })).rejects.toThrow("session scope");
  });

  // --- restore hunk scope ---

  it("restore rejects hunk from another task", async () => {
    commandPort.hunks = [
      { ref: "t1:h1", path: "a.ts", before: "", after: "x", context: [], status: "pending" },
    ];
    await expect(
      handlers.restore({ taskId: "t1", routeId: "main", hunkRef: "t2:h1", expectedVersion: "v1" }),
    ).rejects.toThrow("hunk scope");
  });

  // --- recoveryWarnings ---

  it("recoveryWarnings returns empty array for clean task", async () => {
    const result = await handlers.recoveryWarnings({ taskId: "t1" });
    expect(result.warnings).toEqual([]);
  });

  // --- validationOverride event ---

  it("complete appends validationOverride event when confirmValidationFailure is true", async () => {
    commandPort.validate = async () => ({
      success: false,
      message: "lint errors",
    });
    const appendedEvents: TaskEvent[] = [];
    commandPort.appendEvent = async (_taskId: string, event: TaskEvent) => {
      appendedEvents.push(event);
    };
    await handlers.complete({ taskId: "t1", confirmValidationFailure: true });
    expect(appendedEvents.length).toBe(1);
    expect(appendedEvents[0].type).toBe("validationOverride");
  });
});
