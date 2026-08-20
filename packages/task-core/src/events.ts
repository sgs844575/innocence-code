import type { FileSnapshotRef, Route, TaskMode, TaskStatus, WorkspaceKind } from "./model";
import { createNodeIdClock, type TaskIdClock } from "./ports";

/**
 * JSON-safe envelope shared by every task event. `eventId`/`at` are optional
 * so raw persisted literals (e.g. a log truncated before its envelope was
 * written) still reduce; the reducer validates every field it consumes.
 */
export interface TaskEventEnvelope {
  eventId?: string;
  at?: string;
}

export interface TaskCreatedEvent extends TaskEventEnvelope {
  type: "taskCreated";
  taskId: string;
  sessionId: string;
  workspaceRoot: string;
  workspaceKind: WorkspaceKind;
  mode: TaskMode;
  routeId: string;
  baselineCheckpointId: string;
  /** Immutable Git base captured when the task starts. */
  baseCommit?: string;
}

export interface TaskStatusEvent extends TaskEventEnvelope {
  type: "taskStatus";
  status: TaskStatus;
}

export interface TurnCheckpointedEvent extends TaskEventEnvelope {
  type: "turnCheckpointed";
  checkpointId: string;
  turnId: string | null;
  routeId: string | null;
  files: FileSnapshotRef[];
}

export interface RouteAttachedEvent extends TaskEventEnvelope {
  type: "routeAttached";
  route: Route;
}

/** Step 2 of the turn commit sequence: checkpoint + manifest are durable. */
export interface TurnPreparedEvent extends TaskEventEnvelope {
  type: "turnPrepared";
  turnId: string;
  checkpointId: string;
  routeId: string;
  role?: "user" | "assistant";
  prompt?: string;
  parentCheckpointId?: string;
}

/** Final event of the turn commit sequence; makes the turn visible. */
export interface TurnCommittedEvent extends TaskEventEnvelope {
  type: "turnCommitted";
  turnId: string;
  checkpointId: string;
  routeId: string;
}

/**
 * Change-capture and attribution event vocabulary (moved from plugin-task in
 * Task 6): the task event log is a SINGLE log, so every event type appended
 * through the TaskRuntimePort lives in this union and {@link reduceTask}
 * validates it — one log, one recovery. plugin-task owns the INTERPRETATION
 * (the attribution state machine); task-core persists and validates shapes.
 */

/** Where a captured change came from (plugin-task's ChangeSource, mirrored). */
export type TaskChangeSource = "declared" | "unknown" | "delegated";

/** The user's answer to an attribution request (plugin-task's Attribution, mirrored). */
export type TaskAttribution = "task-owned" | "external";

/** One captured change to a declared write target. */
export interface ChangeRecordedEvent extends TaskEventEnvelope {
  type: "changeRecorded";
  path: string;
  source: TaskChangeSource;
  beforeHash: string | null;
  afterHash: string | null;
}

/** Unknown-source changes paused for explicit user attribution. */
export interface AttributionPendingEvent extends TaskEventEnvelope {
  type: "attributionPending";
  paths: string[];
}

/** Unknown-source changes that overlap a declared (expected) task write. */
export interface AttributionConflictEvent extends TaskEventEnvelope {
  type: "attributionConflict";
  paths: string[];
}

/** The user's attribution answer for one previously paused path. */
export interface AttributionResolvedEvent extends TaskEventEnvelope {
  type: "attributionResolved";
  path: string;
  attribution: TaskAttribution;
  status: "pending-review" | "excluded";
  protectedHash: string | null;
}

/**
 * The user's attribution answer for one CONFLICTED path (Task 13): the event
 * union previously had no explicit conflict-resolution event, so a conflict
 * could never be cleared through the log. plugin-task folds this into the
 * attribution state machine exactly like attributionResolved (task-owned →
 * pending-review, external → excluded), which is what clears the capture
 * middleware's write block.
 */
export interface ConflictResolvedEvent extends TaskEventEnvelope {
  type: "conflictResolved";
  path: string;
  attribution: TaskAttribution;
}

/**
 * Review decision for one hunk (Task 13): hunk review statuses persist in the
 * single log; listHunks re-derives hunks from checkpoints and replays these
 * decisions (refs are content fingerprints, so same content = same ref).
 */
export interface HunkReviewedEvent extends TaskEventEnvelope {
  type: "hunkReviewed";
  routeId: string;
  hunkRef: string;
  status: "accepted" | "restored";
}

/**
 * Persisted active-route transition (Task 13): routeAttached only ever ADDS a
 * route, so switching BACK to an existing route previously had no event.
 * The reducer validates the target route exists and folds it into the head.
 */
export interface ActiveRouteChangedEvent extends TaskEventEnvelope {
  type: "activeRouteChanged";
  routeId: string;
}

/**
 * Completion proceeded past a failed validation with the user's explicit
 * confirmation (Task 13; previously main appended an untyped literal that
 * could not replay). Envelope-only fold — the recorded result is evidence.
 */
export interface ValidationOverrideEvent extends TaskEventEnvelope {
  type: "validationOverride";
  validationResult: { success: boolean; message?: string };
}

export type TaskEvent =
  | TaskCreatedEvent
  | TaskStatusEvent
  | TurnCheckpointedEvent
  | RouteAttachedEvent
  | TurnPreparedEvent
  | TurnCommittedEvent
  | ChangeRecordedEvent
  | AttributionPendingEvent
  | AttributionConflictEvent
  | AttributionResolvedEvent
  | ConflictResolvedEvent
  | HunkReviewedEvent
  | ActiveRouteChangedEvent
  | ValidationOverrideEvent;

const defaultClock = createNodeIdClock();

const clockOf = (input: { clock?: TaskIdClock }): TaskIdClock => input.clock ?? defaultClock;

export interface TaskCreatedEventInput extends TaskEventEnvelope {
  clock?: TaskIdClock;
  taskId?: string;
  sessionId?: string;
  workspaceRoot?: string;
  workspaceKind?: WorkspaceKind;
  mode?: TaskMode;
  routeId?: string;
  baselineCheckpointId?: string;
  baseCommit?: string;
}

/** Zero-argument friendly factory: every field has a domain default. */
export function taskCreatedEvent(input: TaskCreatedEventInput = {}): TaskCreatedEvent {
  const clock = clockOf(input);
  return {
    type: "taskCreated",
    eventId: input.eventId ?? clock.newId("event"),
    at: input.at ?? clock.now(),
    taskId: input.taskId ?? clock.newId("task"),
    sessionId: input.sessionId ?? clock.newId("session"),
    workspaceRoot: input.workspaceRoot ?? "",
    workspaceKind: input.workspaceKind ?? "snapshot",
    mode: input.mode ?? "baseline",
    routeId: input.routeId ?? clock.newId("route"),
    baselineCheckpointId: input.baselineCheckpointId ?? clock.newId("checkpoint"),
    ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
  };
}

export interface TurnCheckpointedEventInput extends TaskEventEnvelope {
  clock?: TaskIdClock;
  checkpointId: string;
  turnId?: string;
  routeId?: string;
  files?: FileSnapshotRef[];
}

/** `routeId` defaults to null meaning "the active route at reduce time". */
export function turnCheckpointedEvent(input: TurnCheckpointedEventInput): TurnCheckpointedEvent {
  const clock = clockOf(input);
  return {
    type: "turnCheckpointed",
    eventId: input.eventId ?? clock.newId("event"),
    at: input.at ?? clock.now(),
    checkpointId: input.checkpointId,
    turnId: input.turnId ?? clock.newId("turn"),
    routeId: input.routeId ?? null,
    files: input.files ? input.files.map((file) => ({ ...file })) : [],
  };
}

export interface TaskStatusEventInput extends TaskEventEnvelope {
  clock?: TaskIdClock;
  status: TaskStatus;
}

export function taskStatusEvent(input: TaskStatusEventInput): TaskStatusEvent {
  const clock = clockOf(input);
  return {
    type: "taskStatus",
    status: input.status,
    eventId: input.eventId ?? clock.newId("event"),
    at: input.at ?? clock.now(),
  };
}

export interface RouteAttachedEventInput extends TaskEventEnvelope {
  clock?: TaskIdClock;
  route: Route;
}

export function routeAttachedEvent(input: RouteAttachedEventInput): RouteAttachedEvent {
  const clock = clockOf(input);
  return {
    type: "routeAttached",
    route: { ...input.route },
    eventId: input.eventId ?? clock.newId("event"),
    at: input.at ?? clock.now(),
  };
}

export interface TurnLifecycleEventInput extends TaskEventEnvelope {
  clock?: TaskIdClock;
  turnId: string;
  checkpointId: string;
  routeId: string;
  role?: "user" | "assistant";
  prompt?: string;
  parentCheckpointId?: string;
}

export function turnPreparedEvent(input: TurnLifecycleEventInput): TurnPreparedEvent {
  const clock = clockOf(input);
  return {
    type: "turnPrepared",
    turnId: input.turnId,
    checkpointId: input.checkpointId,
    routeId: input.routeId,
    ...(input.role ? { role: input.role } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.parentCheckpointId ? { parentCheckpointId: input.parentCheckpointId } : {}),
    eventId: input.eventId ?? clock.newId("event"),
    at: input.at ?? clock.now(),
  };
}

export function turnCommittedEvent(input: TurnLifecycleEventInput): TurnCommittedEvent {
  const clock = clockOf(input);
  return {
    type: "turnCommitted",
    turnId: input.turnId,
    checkpointId: input.checkpointId,
    routeId: input.routeId,
    eventId: input.eventId ?? clock.newId("event"),
    at: input.at ?? clock.now(),
  };
}

export interface ConflictResolvedEventInput extends TaskEventEnvelope {
  clock?: TaskIdClock;
  path: string;
  attribution: TaskAttribution;
}

export function conflictResolvedEvent(input: ConflictResolvedEventInput): ConflictResolvedEvent {
  const clock = clockOf(input);
  return {
    type: "conflictResolved",
    path: input.path,
    attribution: input.attribution,
    eventId: input.eventId ?? clock.newId("event"),
    at: input.at ?? clock.now(),
  };
}

export interface HunkReviewedEventInput extends TaskEventEnvelope {
  clock?: TaskIdClock;
  routeId: string;
  hunkRef: string;
  status: "accepted" | "restored";
}

export function hunkReviewedEvent(input: HunkReviewedEventInput): HunkReviewedEvent {
  const clock = clockOf(input);
  return {
    type: "hunkReviewed",
    routeId: input.routeId,
    hunkRef: input.hunkRef,
    status: input.status,
    eventId: input.eventId ?? clock.newId("event"),
    at: input.at ?? clock.now(),
  };
}

export interface ActiveRouteChangedEventInput extends TaskEventEnvelope {
  clock?: TaskIdClock;
  routeId: string;
}

export function activeRouteChangedEvent(input: ActiveRouteChangedEventInput): ActiveRouteChangedEvent {
  const clock = clockOf(input);
  return {
    type: "activeRouteChanged",
    routeId: input.routeId,
    eventId: input.eventId ?? clock.newId("event"),
    at: input.at ?? clock.now(),
  };
}

export interface ValidationOverrideEventInput extends TaskEventEnvelope {
  clock?: TaskIdClock;
  validationResult: { success: boolean; message?: string };
}

export function validationOverrideEvent(input: ValidationOverrideEventInput): ValidationOverrideEvent {
  const clock = clockOf(input);
  return {
    type: "validationOverride",
    validationResult: { ...input.validationResult },
    eventId: input.eventId ?? clock.newId("event"),
    at: input.at ?? clock.now(),
  };
}
