// Task-related IPC channels and DTOs — the narrow renderer-facing contract for
// task review/route/complete operations.  All DTOs carry taskId and routeId
// (never absolute paths).  expectedVersion is an opaque token from the backend
// that the renderer cannot forge.
//
// This file declares:
//   - Channel name constants (TaskIpcChannels)
//   - DTOs for every request/response pair
//   - TaskIpcApi interface (renderer-callable subset, mirrors InnocenceCodeApi)

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export const TaskIpcChannels = {
  taskGet: "task:get",
  taskChange: "task:change",
  taskCheckpoint: "task:checkpoint",
  taskReview: "task:review",
  taskRestore: "task:restore",
  taskListRoutes: "task:list-routes",
  taskSwitchRoute: "task:switch-route",
  taskForkRoute: "task:fork-route",
  taskEditUserMessage: "task:edit-user-message",
  taskRetryAssistant: "task:retry-assistant",
  taskComplete: "task:complete",
  taskApply: "task:apply",
  taskResolveConflict: "task:resolve-conflict",
  taskValidate: "task:validate",
  taskRecoveryWarnings: "task:recovery-warnings",
  // Main -> renderer push channels (Task 12): live task events and
  // recovery/resource-failure notices.
  taskEvent: "task:event",
  taskNotice: "task:notice",
  // Renderer-initiated recovery retry (worktree/replay failure retry entry).
  taskRecover: "task:recover",
} as const;

// ---------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------

export interface TaskRouteSummary {
  routeId: string;
  parentRouteId: string | null;
  /** Turn the route forked from; null for the task's first route. */
  forkTurnId: string | null;
  checkpointId: string;
  workspaceRoot?: string;
  /** Task workspace class ("git" | "snapshot") — real value from main. */
  workspaceKind: string;
}

export interface ValidationResult {
  success: boolean;
  message?: string;
}

export interface ConflictDetail {
  path: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// DTOs (request shapes — all carry taskId + routeId where applicable)
// ---------------------------------------------------------------------------

export interface TaskReviewDto {
  taskId: string;
  routeId: string;
  hunkRef: string | null;
  status: "accepted" | "restored";
  expectedVersion: string;
}

export interface CompletionGate {
  runningTools: number;
  unresolvedConflicts: number;
  unstableCalls: number;
  unreviewedChanges: number;
  validation: ValidationResult | null;
}

/** Response from task:complete — thrown as a structured error when the gate blocks. */
export interface CompletionGateResult {
  gate: CompletionGate;
  message: string;
}

// ---------------------------------------------------------------------------
// Request / Response DTOs per channel
// ---------------------------------------------------------------------------

export interface TaskGetRequest {
  taskId: string;
}

export interface TaskGetResponse {
  taskId: string;
  /** Chat session the task belongs to (session-scoped renderer filtering). */
  sessionId: string;
  status: string;
  activeRouteId: string;
  mode: string;
  workspaceKind: string;
  /** Opaque version token (lastCommittedEventId) for CAS-flavored commands. */
  version?: string;
  /** Current Git branch of the task workspace; null when unknown/detached (chip hidden). */
  gitBranch?: string | null;
}

export interface TaskChangeRequest {
  taskId: string;
  status?: string;
}

export interface TaskCheckpointRequest {
  taskId: string;
  routeId: string;
}

export interface TaskCheckpointResponse {
  checkpointId: string;
}

export interface TaskRestoreRequest {
  taskId: string;
  routeId: string;
  hunkRef: string;
  expectedVersion: string;
}

export interface TaskListRoutesRequest {
  taskId: string;
}

export interface TaskListRoutesResponse {
  routes: TaskRouteSummary[];
}

export interface TaskSwitchRouteRequest {
  taskId: string;
  routeId: string;
}

export interface TaskForkRouteResponse extends TaskRouteSummary {
  /** Prompt to send on the new route (edited or the original retry prompt). */
  prompt: string;
}

export interface TaskForkRouteRequest {
  sessionId: string;
  taskId: string;
  sourceRouteId: string;
  sourceTurnId: string;
  mode: "edit-user" | "retry-assistant";
  editedText?: string;
  routeName: string;
}

export interface TaskEditUserMessageRequest {
  taskId: string;
  routeId: string;
  turnId: string;
  text: string;
}

export interface TaskRetryAssistantRequest {
  taskId: string;
  routeId: string;
  turnId: string;
}

export interface TaskCompleteRequest {
  taskId: string;
  confirmValidationFailure: boolean;
}

export interface TaskApplyRequest {
  taskId: string;
  routeId: string;
}

export interface TaskApplyResponse {
  status: "applied" | "conflict";
  conflicts?: ConflictDetail[];
}

export interface TaskResolveConflictRequest {
  taskId: string;
  routeId: string;
  path: string;
  attribution: "task-owned" | "external";
}

export interface TaskValidateRequest {
  taskId: string;
  routeId: string;
}

export interface TaskRecoveryWarningsRequest {
  taskId: string;
}

export interface TaskRecoveryWarningsResponse {
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Main -> renderer push DTOs (Task 12)
// ---------------------------------------------------------------------------

/** The task event vocabulary task-core appends to the single event log. */
export type TaskEventKind =
  | "taskCreated"
  | "taskStatus"
  | "turnCheckpointed"
  | "routeAttached"
  | "turnPrepared"
  | "turnCommitted"
  | "changeRecorded"
  | "attributionPending"
  | "attributionConflict"
  | "attributionResolved";

/** routeAttached payload: route identity only, never absolute paths. */
export interface TaskRouteEventData {
  routeId: string;
  parentRouteId: string | null;
  forkTurnId: string | null;
  checkpointId: string;
  workspaceKind: string;
}

/** One live task event, forwarded from the bridge to the renderer. */
export interface TaskUiEvent {
  taskId: string;
  sessionId: string;
  /** Route the event belongs to (task-level events carry the active route). */
  routeId: string;
  kind: TaskEventKind;
  /** Opaque version token after this event (lastCommittedEventId). */
  version?: string;
  /** taskStatus payload. */
  status?: string;
  /** routeAttached payload. */
  route?: TaskRouteEventData;
}

/** How to retry a failed isolated-worktree start/recovery (never baseline). */
export interface TaskWorktreeRetry {
  taskId: string;
  sessionId: string;
  routeId: string;
  mode: "isolated";
}

/**
 * Recovery / resource-failure notices. Each maps to a visible renderer
 * warning plus a gate (see workbenchState.ts):
 *   - eventRecoveryFailed  -> write tools blocked
 *   - worktreeFailed       -> error + retry command retained (no baseline fallback)
 *   - checkpointFailed     -> checkpoint-failed shown, completion blocked
 *   - inconsistencyRecovered -> recovered from the last complete event + notify
 *   - restartRecovered     -> restart warning visible
 */
export type TaskUiNotice =
  | {
      type: "eventRecoveryFailed";
      taskId: string;
      sessionId: string;
      routeId: string;
      message: string;
    }
  | {
      type: "worktreeFailed";
      taskId: string;
      sessionId: string;
      routeId: string;
      message: string;
      retry: TaskWorktreeRetry;
    }
  | {
      type: "checkpointFailed";
      taskId: string;
      sessionId: string;
      routeId: string;
      message: string;
    }
  | {
      type: "inconsistencyRecovered";
      taskId: string;
      sessionId: string;
      routeId: string;
      message: string;
      /** Last complete event the state was recovered from. */
      recoveredFromEventId: string;
    }
  | {
      type: "restartRecovered";
      taskId: string;
      sessionId: string;
      routeId: string;
      warnings: readonly string[];
    };

export interface TaskRecoverRequest {
  taskId: string;
}

// ---------------------------------------------------------------------------
// Renderer-callable API surface (typed like InnocenceCodeApi)
// ---------------------------------------------------------------------------

export interface TaskIpcApi {
  getTask(request: TaskGetRequest): Promise<TaskGetResponse>;
  changeTask(request: TaskChangeRequest): Promise<void>;
  checkpoint(request: TaskCheckpointRequest): Promise<TaskCheckpointResponse>;
  review(request: TaskReviewDto): Promise<void>;
  restore(request: TaskRestoreRequest): Promise<void>;
  listRoutes(request: TaskListRoutesRequest): Promise<TaskListRoutesResponse>;
  switchRoute(request: TaskSwitchRouteRequest): Promise<void>;
  forkRoute(request: TaskForkRouteRequest): Promise<TaskForkRouteResponse>;
  editUserMessage(request: TaskEditUserMessageRequest): Promise<{ turnId: string }>;
  retryAssistant(request: TaskRetryAssistantRequest): Promise<{ turnId: string }>;
  complete(request: TaskCompleteRequest): Promise<void>;
  applyAccepted(request: TaskApplyRequest): Promise<TaskApplyResponse>;
  resolveConflict(request: TaskResolveConflictRequest): Promise<void>;
  validate(request: TaskValidateRequest): Promise<ValidationResult>;
  recoveryWarnings(request: TaskRecoveryWarningsRequest): Promise<TaskRecoveryWarningsResponse>;
  /** Re-runs runtime recovery (worktree/replay retry entry point). */
  recoverTask(request: TaskRecoverRequest): Promise<TaskGetResponse>;
  /** Live task event push (bridge -> renderer). */
  onTaskEvent(cb: (event: TaskUiEvent) => void): () => void;
  /** Recovery / resource-failure notices (main -> renderer). */
  onTaskNotice(cb: (notice: TaskUiNotice) => void): () => void;
}
