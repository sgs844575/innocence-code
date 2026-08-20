/**
 * Public types and constants of the ONE host-agnostic TaskCommandService
 * (split out of command-service.ts by responsibility; command-service.ts
 * re-exports everything so the package surface is unchanged).
 */
import type { TaskEvent } from "./events";
import type {
  Checkpoint,
  Hunk,
  TaskMode,
  TaskStatus,
  WorkspaceKind,
} from "./model";
import type { TaskState } from "./reducer";
import type { Route } from "./model";
import type {
  TaskApplyConflict,
  TaskAttributionPort,
  TaskCommandGit,
  TaskCommandLocks,
  TaskCommandStore,
  TaskCommandWorkspace,
  TaskDeletePort,
  TaskDiffPort,
  TaskForkCommand,
  TaskRecoverPort,
  TaskRouteForkPort,
  TaskStartedInfo,
  TaskValidationResult,
  TaskValidator,
} from "./command-ports";
import type { TaskIdClock } from "./ports";

/** The plan-fixed method set every TaskCommandService exposes. */
export const TASK_COMMAND_METHODS = [
  "start",
  "get",
  "getChanges",
  "getCheckpoint",
  "listRoutes",
  "switchRoute",
  "forkFromUser",
  "retryAssistant",
  "listHunks",
  "review",
  "restore",
  "attributeUnknown",
  "resolveConflict",
  "validate",
  "complete",
  "applyAccepted",
  "recover",
  "delete",
  "recoveryWarnings",
] as const;

export interface TaskStartCommand {
  workspaceRoot: string;
  mode: TaskMode;
  sessionId?: string;
  taskId?: string;
  routeId?: string;
}

export interface TaskGetResult {
  taskId: string;
  sessionId: string;
  status: TaskStatus;
  activeRouteId: string;
  mode: TaskMode;
  workspaceKind: WorkspaceKind;
  version?: string;
  unreviewedChanges: number;
}

export interface TaskRouteSummaryDto {
  routeId: string;
  parentRouteId: string | null;
  forkTurnId: string | null;
  checkpointId: string;
  workspaceKind: WorkspaceKind;
}

export interface TaskForkResult {
  route: TaskRouteSummaryDto & { workspaceRoot?: string };
  prompt: string;
}

export interface CompletionGateDto {
  runningTools: number;
  unresolvedConflicts: number;
  unstableCalls: number;
  unreviewedChanges: number;
  validation: TaskValidationResult | null;
}

export interface TaskCommandService {
  start(request: TaskStartCommand): Promise<TaskStartedInfo>;
  get(taskId: string): Promise<TaskGetResult>;
  getChanges(taskId: string, routeId: string): Promise<import("./command-ports").TaskFilePatch[]>;
  getCheckpoint(taskId: string, checkpointId: string): Promise<Checkpoint | null>;
  listRoutes(taskId: string): Promise<TaskRouteSummaryDto[]>;
  switchRoute(taskId: string, routeId: string): Promise<TaskRouteSummaryDto>;
  forkFromUser(request: TaskForkCommand & { editedText: string }): Promise<TaskForkResult>;
  retryAssistant(request: TaskForkCommand): Promise<TaskForkResult>;
  listHunks(taskId: string, routeId: string): Promise<Hunk[]>;
  review(request: {
    taskId: string;
    routeId: string;
    hunkRef: string;
    status: "accepted" | "restored";
    expectedVersion?: string;
  }): Promise<void>;
  restore(request: {
    taskId: string;
    routeId: string;
    hunkRef: string;
    expectedVersion: string;
  }): Promise<void>;
  attributeUnknown(taskId: string, path: string, attribution: "task-owned" | "external"): Promise<void>;
  resolveConflict(request: {
    taskId: string;
    routeId: string;
    path: string;
    attribution: "task-owned" | "external";
  }): Promise<void>;
  validate(taskId: string, routeId: string): Promise<TaskValidationResult>;
  complete(request: { taskId: string; confirmValidationFailure: boolean }): Promise<void>;
  applyAccepted(
    taskId: string,
    routeId: string,
    options?: { dryRun?: boolean },
  ): Promise<{ applied: string[]; conflicts: TaskApplyConflict[] }>;
  recover(taskId: string): Promise<TaskGetResult>;
  delete(taskId: string): Promise<void>;
  recoveryWarnings(taskId: string): Promise<string[]>;

  // -- Host escape hatches beyond the fixed set (documented): the Electron
  //    DTO surface's checkpoint/status channels and raw appends. ------------
  createCheckpoint(taskId: string, routeId: string): Promise<{ checkpointId: string }>;
  changeStatus(taskId: string, status: string): Promise<void>;
  append(taskId: string, event: TaskEvent): Promise<void>;
}

export interface TaskCommandDeps {
  store: TaskCommandStore;
  locks: TaskCommandLocks;
  workspace: TaskCommandWorkspace;
  git: TaskCommandGit;
  diff: TaskDiffPort;
  attribution: TaskAttributionPort;
  fork: TaskRouteForkPort;
  recover: TaskRecoverPort;
  delete: TaskDeletePort;
  validator?: TaskValidator;
  /** Isolated worktree placement; required for isolated starts. */
  worktreeDir?: string;
  /** Bounded wait for the lease pair (default 30s; never waits forever). */
  lockTimeoutMs?: number;
  clock?: TaskIdClock;
  onEvent?: (taskId: string, event: TaskEvent) => void;
  /** Agent-writer seam: invoked after a task becomes durable (tests simulate agent writes here). */
  onTaskStarted?: (task: TaskStartedInfo) => Promise<void>;
  log?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
}

export const TASK_STATUSES: ReadonlySet<string> = new Set<TaskStatus>([
  "ready", "running", "review", "paused", "completed", "interrupted", "checkpoint-failed",
]);
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/** .git internals never belong to snapshots (mirrors task-workspace's predicate). */
export const isGitInternal = (relativePath: string) =>
  relativePath === ".git" || relativePath.startsWith(".git/");

/**
 * Opaque workspace version token: the last committed event id — the SAME
 * token main's TaskGetResponse.version hands the renderer, so CAS-flavored
 * commands round-trip between hosts unchanged.
 */
export function versionOf(events: readonly TaskEvent[]): string {
  return events.at(-1)?.eventId ?? "";
}

export function routeSummary(state: TaskState, route: Route): TaskRouteSummaryDto {
  return {
    routeId: route.routeId,
    parentRouteId: route.parentRouteId,
    forkTurnId: route.forkTurnId,
    checkpointId: route.checkpointId,
    workspaceKind: state.workspaceKind,
  };
}
