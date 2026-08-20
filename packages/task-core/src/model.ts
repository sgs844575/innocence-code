/**
 * Fixed P1 domain types (contract block from the plan) plus immutable
 * model helpers. These types are the shared contract for task review and
 * branch workflows — later P1 packages must import them from here instead
 * of redefining them.
 */

export type WorkspaceKind = "git" | "snapshot";
export type TaskMode = "baseline" | "isolated";
export type TaskStatus =
  | "ready"
  | "running"
  | "review"
  | "paused"
  | "completed"
  | "interrupted"
  | "checkpoint-failed";
export type ReviewStatus = "pending" | "accepted" | "restored" | "conflict";

export interface TaskHead {
  schemaVersion: 1;
  taskId: string;
  sessionId: string;
  workspaceRoot: string;
  workspaceKind: WorkspaceKind;
  mode: TaskMode;
  activeRouteId: string;
  status: TaskStatus;
  lastCommittedEventId: string | null;
}

export interface Route {
  routeId: string;
  parentRouteId: string | null;
  forkTurnId: string | null;
  checkpointId: string;
  workspaceRoot: string;
  readonly: boolean;
}

export interface FileSnapshotRef {
  path: string;
  exists: boolean;
  hash: string | null;
  mode: number | null;
  binary: boolean;
}

export interface Checkpoint {
  checkpointId: string;
  taskId: string;
  routeId: string;
  turnId: string;
  files: FileSnapshotRef[];
}

export interface Hunk {
  ref: string;
  path: string;
  before: string;
  after: string;
  context: string[];
  status: ReviewStatus;
}

export interface CreateTaskHeadInput {
  taskId: string;
  sessionId: string;
  workspaceRoot: string;
  workspaceKind: WorkspaceKind;
  mode: TaskMode;
  activeRouteId: string;
}

/** Creates a ready task head with schema version 1 and no committed event. */
export function createTaskHead(input: CreateTaskHeadInput): TaskHead {
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
    workspaceKind: input.workspaceKind,
    mode: input.mode,
    activeRouteId: input.activeRouteId,
    status: "ready",
    lastCommittedEventId: null,
  };
}

/** Returns a new head with a different task status; the input stays untouched. */
export function withTaskStatus(head: TaskHead, status: TaskStatus): TaskHead {
  return { ...head, status };
}

/** Returns a new head pointing at another route; the input stays untouched. */
export function withActiveRouteId(head: TaskHead, activeRouteId: string): TaskHead {
  return { ...head, activeRouteId };
}

/** Returns a new head with the last committed event id advanced. */
export function withLastCommittedEventId(head: TaskHead, eventId: string | null): TaskHead {
  return { ...head, lastCommittedEventId: eventId };
}

export interface CreateCheckpointInput {
  checkpointId: string;
  taskId?: string;
  routeId?: string;
  turnId?: string;
  files?: FileSnapshotRef[];
}

/** Creates a checkpoint; file entries are deep-copied, never aliased. */
export function createCheckpoint(input: CreateCheckpointInput): Checkpoint {
  return {
    checkpointId: input.checkpointId,
    taskId: input.taskId ?? "",
    routeId: input.routeId ?? "",
    turnId: input.turnId ?? "",
    files: input.files ? input.files.map((file) => ({ ...file })) : [],
  };
}

/**
 * Adds (or replaces, for an already-recorded path) a file snapshot and
 * returns a NEW checkpoint. The input checkpoint and its file objects are
 * never mutated, and the stored file object is a copy of the argument.
 */
export function addFile(checkpoint: Checkpoint, file: FileSnapshotRef): Checkpoint {
  const files = checkpoint.files.some((existing) => existing.path === file.path)
    ? checkpoint.files.map((existing) => (existing.path === file.path ? { ...file } : existing))
    : [...checkpoint.files, { ...file }];
  return { ...checkpoint, files };
}
