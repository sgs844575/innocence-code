/**
 * Ports of the host-agnostic TaskCommandService (Task 13).
 *
 * task-core defines ONLY the contracts here; the real implementations live in
 * the existing packages and are wired by hosts (Electron's bridge-backed
 * adapter and @innocencecode/task-cli's runtime factory):
 *   - TaskCommandStore / TaskCommandLocks / TaskCommandWorkspace →
 *     @innocencecode/task-workspace (repository, CAS, file locks, scanner)
 *   - TaskCommandGit → @innocencecode/task-git (worktrees, baseline, apply)
 *   - TaskDiffPort → task-workspace's patch engine (CAS-aware checkpoint diff)
 *   - attribution decisions → @innocencecode/plugin-task's state machine
 *
 * The structural shapes deliberately mirror the implementing packages' types
 * (same precedent as the mirrored apply DTOs in task-git) so implementations
 * satisfy the ports without adapters. Git baselines and worktree leases are
 * opaque (`unknown`) here: task-core never interprets them, it only persists
 * and hands them back.
 */
import type { TaskEvent } from "./events";
import type { ForkRequest } from "./fork";
import type {
  Checkpoint,
  FileSnapshotRef,
  Hunk,
  Route,
  TaskHead,
  WorkspaceKind,
} from "./model";
import type { TaskState } from "./reducer";

/** Structured command failure; `code` is the stable contract for adapters. */
export type TaskCommandErrorCode =
  | "task-not-found"
  | "route-not-found"
  | "hunk-not-found"
  | "version-conflict"
  | "session-scope"
  | "completion-gate"
  | "apply-conflict"
  | "lock-timeout"
  | "invalid-request";

export class TaskCommandError extends Error {
  readonly code: TaskCommandErrorCode;
  readonly details?: unknown;

  constructor(code: TaskCommandErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "TaskCommandError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Mutation lease for one command: acquired by the service in the FIXED order
 * (task lease first, workspace lease second) and structurally identical to
 * plugin-task's TaskMutationContext, so live runtime ports hand out contexts
 * the service can consume unchanged.
 */
export interface TaskMutationLease extends AsyncDisposable {
  readonly taskId: string;
  readonly routeId: string;
  readonly workspaceKey: string;
  readonly leaseToken: symbol;
}

export interface TaskLeaseOwner {
  taskId: string;
  routeId: string;
}

/** Cross-process lock pair backing every service mutation. */
export interface TaskCommandLocks {
  /** Task mutation lease; acquired FIRST. */
  acquireTaskLease(taskId: string, owner: TaskLeaseOwner, signal?: AbortSignal): Promise<AsyncDisposable>;
  /** Workspace write lease; acquired SECOND (after the task lease). */
  acquireWorkspaceLease(workspaceKey: string, owner: TaskLeaseOwner, signal?: AbortSignal): Promise<AsyncDisposable>;
}

/** Durable per-task storage: event log, checkpoints, CAS objects, artifacts, head. */
export interface TaskCommandStore {
  listEvents(taskId: string): Promise<TaskEvent[]>;
  appendEvents(taskId: string, events: readonly TaskEvent[]): Promise<void>;
  readTaskHead(taskId: string): Promise<TaskHead | null>;
  writeTaskHead(taskId: string, head: TaskHead): Promise<void>;
  readCheckpoint(taskId: string, checkpointId: string): Promise<Checkpoint | null>;
  writeCheckpoint(taskId: string, checkpoint: Checkpoint): Promise<void>;
  /** CAS-put content bytes; returns the content hash. */
  putObject(taskId: string, bytes: Uint8Array): Promise<string>;
  getObject(taskId: string, hash: string): Promise<Uint8Array>;
  /** Named durable artifact (e.g. the captured Git baseline JSON). */
  writeArtifact(taskId: string, name: string, data: string): Promise<void>;
  readArtifact(taskId: string, name: string): Promise<string | null>;
}

/** Read-side workspace operations (scans and content reads; writes go through the git port). */
export interface TaskCommandWorkspace {
  canonicalKey(root: string): Promise<string>;
  scan(root: string): Promise<{ root: string; files: FileSnapshotRef[] }>;
  hash(root: string, relativePath: string): Promise<string | null>;
  read(root: string, relativePath: string): Promise<Uint8Array | null>;
}

export interface TaskGitInfo {
  isRepo: boolean;
  /** Canonical repository toplevel. */
  root: string;
  branch: string | null;
}

/** One file of a three-way or reverse apply request. */
export interface TaskApplyFile {
  path: string;
  /** Hash the workspace file must currently hold (null = must be absent). */
  expectedHash: string | null;
  /** Hash to restore to (null = delete the file). */
  restoreHash: string | null;
}

export interface TaskIsolatedApplyFile {
  path: string;
  /** Hash at the fork base checkpoint; null when the file did not exist there. */
  baseHash: string | null;
  /** Hash of the accepted content; null = delete the file. */
  incomingHash: string | null;
}

export type TaskApplyInput =
  | { mode: "baseline"; root: string; files: readonly TaskApplyFile[]; readContent: (hash: string) => Promise<Uint8Array> }
  | { mode: "isolated"; root: string; files: readonly TaskIsolatedApplyFile[]; readContent: (hash: string) => Promise<Uint8Array> };

export interface TaskApplyConflict {
  path: string;
  expected: string | null;
  actual: string | null;
}

/** Git operations (worktrees, baseline capture, preflight and apply). */
export interface TaskCommandGit {
  detect(root: string): Promise<TaskGitInfo>;
  captureBaseline(root: string): Promise<unknown>;
  /** Creates a detached worktree; returns its path plus the opaque lease. */
  createWorktree(input: { root: string; path: string; baseCommit?: string }): Promise<{ path: string; lease: unknown }>;
  overlayBaseline(lease: unknown, baseline: unknown): Promise<void>;
  recoverWorktree(input: {
    root: string;
    path: string;
    baseCommit: string;
    baseline: unknown;
    checkpointFiles: readonly { path: string; hash: string | null }[];
    readContent: (hash: string) => Promise<Uint8Array>;
  }): Promise<{ path: string; lease: unknown }>;
  destroyWorktree(lease: unknown): Promise<void>;
  closeLease(lease: unknown): Promise<void>;
  preflightApply(input: TaskApplyInput): Promise<{ conflicts: TaskApplyConflict[]; clean: boolean }>;
  applyAccepted(input: TaskApplyInput): Promise<{ applied: string[]; conflicts: TaskApplyConflict[] }>;
}

/** One changed file with its line hunks (structure of task-workspace's FilePatch). */
export interface TaskFilePatch {
  path: string;
  before: FileSnapshotRef;
  after: FileSnapshotRef;
  binary: boolean;
  hunks: Hunk[];
}

/**
 * Checkpoint-vs-workspace diff. Before-content arrives through the CAS reader
 * (the checkpoint state may no longer exist on disk), after-content from the
 * live workspace root.
 */
export interface TaskDiffPort {
  diff(input: {
    before: { files: readonly FileSnapshotRef[]; readContent: (hash: string) => Promise<Uint8Array> };
    after: { root: string; files: readonly FileSnapshotRef[] };
  }): Promise<TaskFilePatch[]>;
}

/** Attribution state as folded by plugin-task; the service only reads statuses. */
export interface TrackedAttribution {
  path: string;
  status: "candidate" | "attribution-pending" | "pending-review" | "excluded" | "conflict";
}

export interface TaskAttributionPort {
  decisions(events: readonly TaskEvent[]): readonly TrackedAttribution[];
}

/** Fork command from the caller (renderer DTO or CLI request). */
export interface TaskForkCommand {
  sessionId: string;
  taskId: string;
  sourceRouteId: string;
  sourceTurnId: string;
  /** Redundant with the method chosen; kept for host DTO parity. */
  mode?: "edit-user" | "retry-assistant";
  editedText?: string;
  routeName: string;
}

/**
 * Worktree-backed route fork. The implementation owns the task lease for the
 * duration (it is NOT held by the service at call time) and appends the
 * routeAttached event atomically with the worktree and checkpoint replay.
 */
export interface TaskRouteForkPort {
  createForkedRoute(input: {
    taskId: string;
    mode: "edit-user" | "retry-assistant";
    request: TaskForkCommand;
    resolved: ForkRequest;
    state: TaskState;
  }): Promise<{ route: Route; prompt: string }>;
}

/** Restart recovery (worktree replay); the implementation owns its leases. */
export interface TaskRecoverPort {
  recoverTask(taskId: string): Promise<TaskState>;
}

/** Explicit task deletion (worktree destruction + storage removal). */
export interface TaskDeletePort {
  deleteTask(taskId: string): Promise<void>;
}

export interface TaskValidationResult {
  success: boolean;
  message?: string;
}

/** Injected validator; when absent validation passes (nothing configured). */
export type TaskValidator = (
  taskId: string,
  routeId: string,
  workspaceRoot: string,
) => Promise<TaskValidationResult>;

export type TaskCommandLogLevel = "info" | "warn" | "error";

export interface TaskCommandLogger {
  (level: TaskCommandLogLevel, msg: string, data?: unknown): void;
}

/** Task identity handed to the agent-writer seam after a successful start. */
export interface TaskStartedInfo {
  taskId: string;
  sessionId: string;
  routeId: string;
  /** Same as routeId at start; kept for DTO parity with get(). */
  activeRouteId: string;
  workspaceRoot: string;
  workspaceKind: WorkspaceKind;
  mode: "baseline" | "isolated";
  baselineCheckpointId: string;
  version: string;
}
