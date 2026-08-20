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
}

/** Final event of the turn commit sequence; makes the turn visible. */
export interface TurnCommittedEvent extends TaskEventEnvelope {
  type: "turnCommitted";
  turnId: string;
  checkpointId: string;
  routeId: string;
}

export type TaskEvent =
  | TaskCreatedEvent
  | TaskStatusEvent
  | TurnCheckpointedEvent
  | RouteAttachedEvent
  | TurnPreparedEvent
  | TurnCommittedEvent;

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
}

export function turnPreparedEvent(input: TurnLifecycleEventInput): TurnPreparedEvent {
  const clock = clockOf(input);
  return {
    type: "turnPrepared",
    turnId: input.turnId,
    checkpointId: input.checkpointId,
    routeId: input.routeId,
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
