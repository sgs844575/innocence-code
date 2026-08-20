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
  TaskStartRequest,
  TaskStartResponse,
  ValidationResult,
} from "../shared/taskIpc";

// ---------------------------------------------------------------------------
// Command port — the mutation surface the handlers delegate to. Task 13
// formalizes the full TaskCommandService; taskCommandService.ts is the real
// (bridge-backed) implementation composed today, fakes remain the test seam.
// ---------------------------------------------------------------------------

export interface TaskCommandPort {
  /**
   * Find-or-create the session's task (the P1 loop entry). Resolves the
   * session's workspace root host-side; create:false returns null when the
   * session has no task. Binds the session's sends to the task route.
   */
  startTask(request: {
    sessionId: string;
    mode?: "baseline" | "isolated";
    create?: boolean;
  }): Promise<import("../shared/taskIpc").TaskStartResponse | null>;
  getHunks(taskId: string, routeId: string): Promise<Hunk[]>;
  listRoutes(taskId: string): Promise<TaskRouteSummary[]>;
  switchRoute(taskId: string, routeId: string): Promise<TaskRouteSummary>;
  forkRoute(request: TaskForkRouteRequest): Promise<TaskForkRouteResponse>;
  reviewHunk(taskId: string, routeId: string, hunkRef: string, status: "accepted" | "restored", expectedVersion?: string): Promise<void>;
  /** Restores one hunk: reverts its file to the checkpoint state (version-guarded). */
  restoreHunk(taskId: string, routeId: string, hunkRef: string, expectedVersion?: string): Promise<void>;
  applyAccepted(taskId: string, routeId: string): Promise<{ applied: string[]; conflicts: ConflictDetail[] }>;
  preflightApply(taskId: string, routeId: string): Promise<
    | { status: "clean" }
    | { status: "conflict"; conflicts: ConflictDetail[] }
  >;
  resolveConflict(taskId: string, routeId: string, path: string, attribution: "task-owned" | "external"): Promise<void>;
  editUserMessage(taskId: string, routeId: string, turnId: string, text: string): Promise<{ turnId: string }>;
  retryAssistant(taskId: string, routeId: string, turnId: string): Promise<{ turnId: string }>;
  createCheckpoint(taskId: string, routeId: string): Promise<TaskCheckpointResponse>;
  changeTaskStatus(taskId: string, status: string): Promise<void>;
  /** Completion gate (delegates to the task-core service, override included). */
  complete(request: { taskId: string; confirmValidationFailure: boolean }): Promise<void>;
  validate(taskId: string, routeId: string): Promise<ValidationResult>;
  /** Re-runs runtime recovery (worktree/replay retry entry point). */
  recoverTask(taskId: string): Promise<TaskGetResponse>;
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

// ---------------------------------------------------------------------------
// TaskIpcHandlers
// ---------------------------------------------------------------------------

export interface TaskIpcHandlersDeps {
  bridge: TaskRuntimeBridge;
  commandPort: TaskCommandPort;
  /** Optional real-branch resolver (TitleBar chip; null = unknown → hidden). */
  resolveGitBranch?: (taskId: string) => Promise<string | null>;
}

export class TaskIpcHandlers {
  private readonly bridge: TaskRuntimeBridge;
  private readonly commandPort: TaskCommandPort;
  private readonly resolveGitBranch?: (taskId: string) => Promise<string | null>;

  constructor(deps: TaskIpcHandlersDeps) {
    this.bridge = deps.bridge;
    this.commandPort = deps.commandPort;
    this.resolveGitBranch = deps.resolveGitBranch;
  }

  // -- Validation helpers --------------------------------------------------

  private async resolveTask(taskId: string): Promise<TaskState> {
    const handle = this.bridge.get(taskId);
    if (!handle) throw new Error(`task not found: ${taskId}`);
    const events = await this.bridge.listEvents(taskId);
    return reduceTask(events);
  }

  private assertRoute(state: TaskState, routeId: string): void {
    assertRouteExists(state, routeId);
  }

  // -- Handlers ------------------------------------------------------------

  /**
   * task:start — find-or-create the session's task. Design choice (final
   * review C1): the EXPLICIT channel composes with session glue — main
   * resolves the workspace root and binds the session's sends to the task
   * route, so the next chat turn enters the P1 loop (task-scoped sends)
   * without a second renderer surface.
   */
  async start(request: TaskStartRequest): Promise<TaskStartResponse | null> {
    if (!request.sessionId) throw new Error("start requires a sessionId");
    return this.commandPort.startTask({
      sessionId: request.sessionId,
      mode: request.mode ?? "baseline",
      create: request.create !== false,
    });
  }

  async getTask(request: { taskId: string }): Promise<TaskGetResponse> {
    const state = await this.resolveTask(request.taskId);
    return {
      taskId: state.taskId,
      sessionId: state.sessionId,
      status: state.status,
      activeRouteId: state.activeRouteId,
      mode: state.mode,
      workspaceKind: state.workspaceKind,
      version: state.lastCommittedEventId ?? undefined,
      gitBranch: this.resolveGitBranch ? await this.resolveGitBranch(request.taskId) : null,
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
      request.expectedVersion,
    );
  }

  async restore(request: TaskRestoreRequest): Promise<void> {
    const state = await this.resolveTask(request.taskId);
    // Hunk scope check BEFORE route validation — consistent with review().
    const hunks = await this.commandPort.getHunks(request.taskId, request.routeId);
    assertHunkScope(hunks, request.hunkRef, request.taskId);
    this.assertRoute(state, request.routeId);
    // The renderer's expectedVersion flows through (review enforces CAS the
    // same way); a stale token rejects with version-conflict.
    await this.commandPort.restoreHunk(
      request.taskId,
      request.routeId,
      request.hunkRef,
      request.expectedVersion,
    );
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
   * Completion gate — fully delegated to the command service (task-core):
   * running tools, unresolved conflicts, unstable calls, unreviewed changes
   * and validation, including the confirmValidationFailure override (the
   * service appends the validationOverride event). A blocked gate surfaces
   * as a structured CompletionGateResult error for the renderer.
   */
  async complete(request: { taskId: string; confirmValidationFailure: boolean }): Promise<void> {
    await this.resolveTask(request.taskId); // validates existence
    try {
      await this.commandPort.complete(request);
    } catch (error) {
      const details = (error as { code?: string; details?: { gate?: CompletionGate } }).code === "completion-gate"
        ? (error as { details?: { gate?: CompletionGate } }).details
        : undefined;
      if (details?.gate !== undefined) {
        throw Object.assign(new Error("completion gate"), { gate: details.gate });
      }
      throw error;
    }
  }

  async applyAccepted(request: { taskId: string; routeId: string }): Promise<TaskApplyResponse> {
    const state = await this.resolveTask(request.taskId);
    this.assertRoute(state, request.routeId);

    const result = await this.commandPort.applyAccepted(request.taskId, request.routeId);
    if (result.conflicts.length > 0) {
      return { status: "conflict", conflicts: result.conflicts };
    }
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

  /** Recovery retry (Task 12): re-runs the bridge's recoverTask and returns
   *  the refreshed task view (real branch included when resolvable). */
  async recover(request: { taskId: string }): Promise<TaskGetResponse> {
    const recovered = await this.commandPort.recoverTask(request.taskId);
    if (this.resolveGitBranch) {
      recovered.gitBranch = await this.resolveGitBranch(request.taskId);
    }
    return recovered;
  }
}
