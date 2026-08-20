// Task IPC handlers — validates renderer requests and delegates mutations to
// the TaskCommandPort.  Testable without Electron: depends only on the
// TaskRuntimeBridge (live task handles + event log) and the command port.
//
// Validation chain per handler:
//   1. Resolve taskId -> existing TaskHandle via bridge
//   2. Reduce event log -> TaskState (routes, turns, status)
//   3. Resolve routeId -> valid Route for that task
//   4. (review) Resolve hunkRef -> Hunk belonging to task/route
//
// Completion gate is computed fresh from the reduced state on every call —
// never cached.

import { reduceTask, type TaskState, type Hunk } from "@innocencecode/task-core";
import type { TaskRuntimeBridge } from "./taskRuntimeBridge";
import type {
  CompletionGate,
  ConflictDetail,
  TaskApplyResponse,
  TaskCheckpointResponse,
  TaskGetResponse,
  TaskForkRouteRequest,
  TaskForkRouteResponse,
  TaskListRoutesResponse,
  TaskRecoveryWarningsResponse,
  TaskRestoreRequest,
  TaskReviewDto,
  TaskRouteSummary,
  ValidationResult,
} from "../shared/taskIpc";

// ---------------------------------------------------------------------------
// Command port — the mutation surface the handlers delegate to.
// Task 13 will formalize this as TaskCommandService; until then this
// plain-object interface is the test seam.
// ---------------------------------------------------------------------------

export interface TaskCommandPort {
  getHunks(taskId: string, routeId: string): Promise<Hunk[]>;
  listRoutes(taskId: string): Promise<TaskRouteSummary[]>;
  switchRoute(taskId: string, routeId: string): Promise<TaskRouteSummary>;
  forkRoute(request: TaskForkRouteRequest): Promise<TaskForkRouteResponse>;
  reviewHunk(taskId: string, routeId: string, hunkRef: string, status: "accepted" | "restored"): Promise<void>;
  applyAccepted(taskId: string, routeId: string): Promise<{ applied: true }>;
  preflightApply(taskId: string, routeId: string): Promise<
    | { status: "clean" }
    | { status: "conflict"; conflicts: ConflictDetail[] }
  >;
  resolveConflict(taskId: string, routeId: string, path: string, attribution: "task-owned" | "external"): Promise<void>;
  editUserMessage(taskId: string, routeId: string, turnId: string, text: string): Promise<{ turnId: string }>;
  retryAssistant(taskId: string, routeId: string, turnId: string): Promise<{ turnId: string }>;
  createCheckpoint(taskId: string, routeId: string): Promise<TaskCheckpointResponse>;
  changeTaskStatus(taskId: string, status: string): Promise<void>;
  validate(taskId: string, routeId: string): Promise<ValidationResult>;
  /** Append a synthetic event to the task log (used for validationOverride). */
  appendEvent(taskId: string, event: import("@innocencecode/task-core").TaskEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertRouteExists(state: TaskState, routeId: string): void {
  if (!state.routes.has(routeId)) {
    throw new Error(`route not found: ${routeId} in task ${state.taskId}`);
  }
}

function assertHunkScope(hunks: Hunk[], hunkRef: string, taskId: string): void {
  // The hunk ref format is "taskId:hunkIndex".  A hunk from another task
  // has a different taskId prefix.
  const prefix = hunkRef.split(":")[0];
  if (prefix !== taskId) {
    throw new Error("hunk scope");
  }
  if (!hunks.some((h) => h.ref === hunkRef)) {
    throw new Error(`hunk not found: ${hunkRef}`);
  }
}

function countUnstableTurns(state: TaskState): number {
  let count = 0;
  for (const turn of state.turns.values()) {
    if (turn.phase === "prepared") count += 1;
  }
  return count;
}

function gateBlocks(gate: CompletionGate): boolean {
  return (
    gate.runningTools > 0 ||
    gate.unresolvedConflicts > 0 ||
    gate.unstableCalls > 0 ||
    gate.unreviewedChanges > 0 ||
    (gate.validation !== null && !gate.validation.success)
  );
}

// ---------------------------------------------------------------------------
// TaskIpcHandlers
// ---------------------------------------------------------------------------

export interface TaskIpcHandlersDeps {
  bridge: TaskRuntimeBridge;
  commandPort: TaskCommandPort;
}

export class TaskIpcHandlers {
  private readonly bridge: TaskRuntimeBridge;
  private readonly commandPort: TaskCommandPort;

  constructor(deps: TaskIpcHandlersDeps) {
    this.bridge = deps.bridge;
    this.commandPort = deps.commandPort;
  }

  // -- Validation helpers --------------------------------------------------

  private async resolveTask(taskId: string): Promise<TaskState> {
    const handle = this.bridge.get(taskId);
    if (!handle) throw new Error(`task not found: ${taskId}`);
    const events = await this.bridge.listEvents(taskId);
    return reduceTask(events);
  }

  /** Returns both the reduced state AND the raw event list (avoids double fetch). */
  private async resolveTaskWithEvents(taskId: string): Promise<{ state: TaskState; events: readonly import("@innocencecode/task-core").TaskEvent[] }> {
    const handle = this.bridge.get(taskId);
    if (!handle) throw new Error(`task not found: ${taskId}`);
    const events = await this.bridge.listEvents(taskId);
    const state = reduceTask(events);
    return { state, events };
  }

  private assertRoute(state: TaskState, routeId: string): void {
    assertRouteExists(state, routeId);
  }

  // -- Handlers ------------------------------------------------------------

  async getTask(request: { taskId: string }): Promise<TaskGetResponse> {
    const state = await this.resolveTask(request.taskId);
    return {
      taskId: state.taskId,
      status: state.status,
      activeRouteId: state.activeRouteId,
      mode: state.mode,
      workspaceKind: state.workspaceKind,
    };
  }

  async changeTask(request: { taskId: string; status?: string }): Promise<void> {
    await this.resolveTask(request.taskId); // validates existence
    if (request.status) {
      await this.commandPort.changeTaskStatus(request.taskId, request.status);
    }
  }

  async checkpoint(request: { taskId: string; routeId: string }): Promise<TaskCheckpointResponse> {
    const state = await this.resolveTask(request.taskId);
    this.assertRoute(state, request.routeId);
    return this.commandPort.createCheckpoint(request.taskId, request.routeId);
  }

  async review(request: TaskReviewDto): Promise<void> {
    const state = await this.resolveTask(request.taskId);
    // Hunk scope check BEFORE route validation — the brief's verbatim test
    // sends a valid routeId with a hunk from another task; scope rejection
    // must fire regardless of route validity.
    if (request.hunkRef !== null) {
      const hunks = await this.commandPort.getHunks(request.taskId, request.routeId);
      assertHunkScope(hunks, request.hunkRef, request.taskId);
    }
    this.assertRoute(state, request.routeId);
    await this.commandPort.reviewHunk(
      request.taskId,
      request.routeId,
      request.hunkRef ?? "",
      request.status,
    );
  }

  async restore(request: TaskRestoreRequest): Promise<void> {
    const state = await this.resolveTask(request.taskId);
    // Hunk scope check BEFORE route validation — consistent with review().
    const hunks = await this.commandPort.getHunks(request.taskId, request.routeId);
    assertHunkScope(hunks, request.hunkRef, request.taskId);
    this.assertRoute(state, request.routeId);
    await this.commandPort.reviewHunk(request.taskId, request.routeId, request.hunkRef, "restored");
  }

  async listRoutes(request: { taskId: string }): Promise<TaskListRoutesResponse> {
    await this.resolveTask(request.taskId); // validates existence
    const routes = await this.commandPort.listRoutes(request.taskId);
    return { routes };
  }

  async switchRoute(request: { taskId: string; routeId: string }): Promise<void> {
    const state = await this.resolveTask(request.taskId);
    this.assertRoute(state, request.routeId);
    await this.commandPort.switchRoute(request.taskId, request.routeId);
  }

  async forkRoute(request: TaskForkRouteRequest): Promise<TaskForkRouteResponse> {
    const handle = this.bridge.get(request.taskId);
    if (!handle) throw new Error(`task not found: ${request.taskId}`);
    const state = await this.resolveTask(request.taskId);
    this.assertRoute(state, request.sourceRouteId);
    if (handle.sessionId !== request.sessionId) throw new Error("forkRoute session scope");
    if (handle.workspaceKind !== "git") {
      throw new Error("Git repository required for code-state fork");
    }
    if (request.mode === "edit-user" && !request.editedText?.trim()) {
      throw new Error("edited text is required");
    }
    return this.commandPort.forkRoute(request);
  }

  async editUserMessage(request: {
    taskId: string;
    routeId: string;
    turnId: string;
    text: string;
  }): Promise<{ turnId: string }> {
    const state = await this.resolveTask(request.taskId);
    this.assertRoute(state, request.routeId);
    return this.commandPort.editUserMessage(
      request.taskId,
      request.routeId,
      request.turnId,
      request.text,
    );
  }

  async retryAssistant(request: {
    taskId: string;
    routeId: string;
    turnId: string;
  }): Promise<{ turnId: string }> {
    const state = await this.resolveTask(request.taskId);
    this.assertRoute(state, request.routeId);
    return this.commandPort.retryAssistant(request.taskId, request.routeId, request.turnId);
  }

  /**
   * Completion gate: checks in order — running tools, unresolved conflicts,
   * unstable calls, unreviewed changes, validation.  Throws a structured
   * CompletionGateResult when any gate blocks.
   */
  async complete(request: { taskId: string; confirmValidationFailure: boolean }): Promise<void> {
    const { state, events } = await this.resolveTaskWithEvents(request.taskId);
    const hunks = await this.commandPort.getHunks(request.taskId, state.activeRouteId);

    // Validation — run it to get the result for the gate.
    const validation = await this.commandPort.validate(request.taskId, state.activeRouteId);

    // Unresolved conflicts — counted from the same event log (no double fetch).
    const unresolvedConflicts = this.countUnresolvedConflictsFromEvents(events);

    const gate: CompletionGate = {
      runningTools: 0, // always zero in P1 (single-turn)
      unresolvedConflicts,
      unstableCalls: countUnstableTurns(state),
      unreviewedChanges: hunks.filter(
        (h) => h.status !== "accepted" && h.status !== "restored",
      ).length,
      validation,
    };

    // Override: confirmValidationFailure allows proceeding past validation
    // AND appends a validationOverride event recording the confirmation.
    if (request.confirmValidationFailure && validation !== null && !validation.success) {
      gate.validation = null;
      await this.commandPort.appendEvent(request.taskId, {
        type: "validationOverride",
        eventId: `evt_val_override_${Date.now()}`,
        at: new Date().toISOString(),
        validationResult: validation,
      } as unknown as import("@innocencecode/task-core").TaskEvent);
    }

    if (gateBlocks(gate)) {
      throw Object.assign(new Error("completion gate"), { gate });
    }
  }

  async applyAccepted(request: { taskId: string; routeId: string }): Promise<TaskApplyResponse> {
    const state = await this.resolveTask(request.taskId);
    this.assertRoute(state, request.routeId);

    const preflight = await this.commandPort.preflightApply(request.taskId, request.routeId);
    if (preflight.status === "conflict") {
      return { status: "conflict", conflicts: preflight.conflicts };
    }
    await this.commandPort.applyAccepted(request.taskId, request.routeId);
    return { status: "applied" };
  }

  async resolveConflict(request: {
    taskId: string;
    routeId: string;
    path: string;
    attribution: "task-owned" | "external";
  }): Promise<void> {
    const state = await this.resolveTask(request.taskId);
    this.assertRoute(state, request.routeId);
    await this.commandPort.resolveConflict(
      request.taskId,
      request.routeId,
      request.path,
      request.attribution,
    );
  }

  async validate(request: { taskId: string; routeId: string }): Promise<ValidationResult> {
    const state = await this.resolveTask(request.taskId);
    this.assertRoute(state, request.routeId);
    return this.commandPort.validate(request.taskId, request.routeId);
  }

  async recoveryWarnings(request: { taskId: string }): Promise<TaskRecoveryWarningsResponse> {
    await this.resolveTask(request.taskId); // validates existence
    const events = await this.bridge.listEvents(request.taskId);
    const warnings: string[] = [];
    // Check for incomplete turns or other anomalies
    const state = reduceTask(events);
    for (const turn of state.turns.values()) {
      if (turn.phase === "prepared") {
        warnings.push(`turn ${turn.turnId} is prepared but not committed`);
      }
    }
    return { warnings };
  }

  // -- Internal helpers ----------------------------------------------------

  /**
   * Counts attribution conflicts from the raw event log that were never
   * resolved.  A conflict path is unresolved if a later
   * attributionResolved event for the same path does not appear.
   */
  private countUnresolvedConflictsFromEvents(events: readonly import("@innocencecode/task-core").TaskEvent[]): number {
    const conflictedPaths = new Set<string>();
    const resolvedPaths = new Set<string>();
    for (const event of events) {
      if (event.type === "attributionConflict") {
        for (const p of event.paths) conflictedPaths.add(p);
      } else if (event.type === "attributionResolved") {
        resolvedPaths.add(event.path);
      }
    }
    let unresolved = 0;
    for (const p of conflictedPaths) {
      if (!resolvedPaths.has(p)) unresolved += 1;
    }
    return unresolved;
  }
}
