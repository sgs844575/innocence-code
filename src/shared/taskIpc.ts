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
} as const;

// ---------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------

export interface TaskRouteSummary {
  routeId: string;
  parentRouteId: string | null;
  checkpointId: string;
  workspaceRoot?: string;
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
  status: string;
  activeRouteId: string;
  mode: string;
  workspaceKind: string;
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
}
