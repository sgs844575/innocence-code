import type { TaskEvent } from "./events";
import {
  createCheckpoint,
  createTaskHead,
  withActiveRouteId,
  withLastCommittedEventId,
  withTaskStatus,
  type Checkpoint,
  type Route,
  type TaskHead,
  type TaskTurn,
} from "./model";
import { attachRoute, createRoute } from "./route";

export type TaskRecoveryErrorKind = "unknown-event" | "incomplete-event";

/**
 * Structured recovery error thrown when an event log cannot be replayed:
 * unknown event types and structurally invalid (e.g. truncated) events are
 * reported with machine-readable fields so callers never have to guess the
 * state — bad events are never silently skipped.
 */
export class TaskRecoveryError extends Error {
  readonly kind: TaskRecoveryErrorKind;
  readonly eventIndex: number;
  readonly reason: string;
  readonly rawType?: string;

  constructor(fields: {
    kind: TaskRecoveryErrorKind;
    eventIndex: number;
    reason: string;
    rawType?: string;
  }) {
    const suffix = fields.rawType === undefined ? "" : ` (raw type: ${fields.rawType})`;
    super(`task recovery failed [${fields.kind}] at event ${fields.eventIndex}: ${fields.reason}${suffix}`);
    this.name = "TaskRecoveryError";
    this.kind = fields.kind;
    this.eventIndex = fields.eventIndex;
    this.reason = fields.reason;
    this.rawType = fields.rawType;
  }
}

/** Reduced task state: the task head plus the route DAG, turn checkpoints and turn phases. */
export interface TaskState extends TaskHead {
  routes: ReadonlyMap<string, Route>;
  checkpoints: ReadonlyMap<string, Checkpoint>;
  turns: ReadonlyMap<string, TaskTurn>;
}

/** Narrows a reduced state back to the persistable task head fields (task.json). */
export function toTaskHead(state: TaskState): TaskHead {
  const { routes: _routes, checkpoints: _checkpoints, turns: _turns, ...head } = state;
  return head;
}

const TASK_STATUSES: ReadonlySet<string> = new Set([
  "ready",
  "running",
  "review",
  "paused",
  "completed",
  "interrupted",
  "checkpoint-failed",
]);
const WORKSPACE_KINDS: ReadonlySet<string> = new Set(["git", "snapshot"]);
const TASK_MODES: ReadonlySet<string> = new Set(["baseline", "isolated"]);
const CHANGE_SOURCES: ReadonlySet<string> = new Set(["declared", "unknown", "delegated"]);
const ATTRIBUTIONS: ReadonlySet<string> = new Set(["task-owned", "external"]);
const ATTRIBUTION_RESOLUTION_STATUSES: ReadonlySet<string> = new Set(["pending-review", "excluded"]);

function incompleteEvent(eventIndex: number, reason: string): TaskRecoveryError {
  return new TaskRecoveryError({ kind: "incomplete-event", eventIndex, reason });
}

function requireNonEmptyString(value: unknown, field: string, eventIndex: number): void {
  if (typeof value !== "string" || value.length === 0) {
    throw incompleteEvent(eventIndex, `${field} must be a non-empty string`);
  }
}

function requireStringOrNull(value: unknown, field: string, eventIndex: number): void {
  if (value !== null && typeof value !== "string") {
    throw incompleteEvent(eventIndex, `${field} must be a string or null`);
  }
}

function requirePathList(value: unknown, field: string, eventIndex: number): void {
  if (!Array.isArray(value)) {
    throw incompleteEvent(eventIndex, `${field} must be an array of paths`);
  }
  value.forEach((entry, entryIndex) =>
    requireNonEmptyString(entry, `${field}[${entryIndex}]`, eventIndex),
  );
}

function requireEnumValue(
  value: unknown,
  field: string,
  values: ReadonlySet<string>,
  eventIndex: number,
): void {
  if (typeof value !== "string" || !values.has(value)) {
    throw incompleteEvent(eventIndex, `${field} must be one of ${[...values].join(" | ")}`);
  }
}

function validateEnvelope(record: Record<string, unknown>, eventIndex: number): void {
  if (record.eventId !== undefined && typeof record.eventId !== "string") {
    throw incompleteEvent(eventIndex, "eventId must be a string");
  }
  if (record.at !== undefined && typeof record.at !== "string") {
    throw incompleteEvent(eventIndex, "at must be a timestamp string");
  }
}

function validateRoute(raw: unknown, eventIndex: number): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw incompleteEvent(eventIndex, "route must be an object");
  }
  const route = raw as Record<string, unknown>;
  requireNonEmptyString(route.routeId, "route.routeId", eventIndex);
  requireStringOrNull(route.parentRouteId, "route.parentRouteId", eventIndex);
  requireStringOrNull(route.forkTurnId, "route.forkTurnId", eventIndex);
  requireNonEmptyString(route.checkpointId, "route.checkpointId", eventIndex);
  if (typeof route.workspaceRoot !== "string") {
    throw incompleteEvent(eventIndex, "route.workspaceRoot must be a string");
  }
  if (typeof route.readonly !== "boolean") {
    throw incompleteEvent(eventIndex, "route.readonly must be a boolean");
  }
  if (route.baseCommit !== undefined) {
    requireNonEmptyString(route.baseCommit, "route.baseCommit", eventIndex);
  }
}

/** Validates one FileSnapshotRef entry of a turnCheckpointed event. */
function validateFileSnapshot(raw: unknown, fileIndex: number, eventIndex: number): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw incompleteEvent(eventIndex, `files[${fileIndex}] must be an object`);
  }
  const file = raw as Record<string, unknown>;
  requireNonEmptyString(file.path, `files[${fileIndex}].path`, eventIndex);
  if (typeof file.exists !== "boolean") {
    throw incompleteEvent(eventIndex, `files[${fileIndex}].exists must be a boolean`);
  }
  requireStringOrNull(file.hash, `files[${fileIndex}].hash`, eventIndex);
  if (file.mode !== null && typeof file.mode !== "number") {
    throw incompleteEvent(eventIndex, `files[${fileIndex}].mode must be a number or null`);
  }
  if (typeof file.binary !== "boolean") {
    throw incompleteEvent(eventIndex, `files[${fileIndex}].binary must be a boolean`);
  }
}

/** Validates one raw event (typed or straight from persisted JSON). */
function validateTaskEvent(raw: unknown, eventIndex: number): TaskEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw incompleteEvent(eventIndex, "event must be an object");
  }
  const record = raw as Record<string, unknown>;
  const rawType = typeof record.type === "string" ? record.type : undefined;
  switch (rawType) {
    case "taskCreated": {
      requireNonEmptyString(record.taskId, "taskId", eventIndex);
      requireNonEmptyString(record.sessionId, "sessionId", eventIndex);
      if (typeof record.workspaceRoot !== "string") {
        throw incompleteEvent(eventIndex, "workspaceRoot must be a string");
      }
      requireEnumValue(record.workspaceKind, "workspaceKind", WORKSPACE_KINDS, eventIndex);
      requireEnumValue(record.mode, "mode", TASK_MODES, eventIndex);
      requireNonEmptyString(record.routeId, "routeId", eventIndex);
      requireNonEmptyString(record.baselineCheckpointId, "baselineCheckpointId", eventIndex);
      if (record.baseCommit !== undefined) requireNonEmptyString(record.baseCommit, "baseCommit", eventIndex);
      validateEnvelope(record, eventIndex);
      return record as unknown as TaskEvent;
    }
    case "taskStatus": {
      requireEnumValue(record.status, "status", TASK_STATUSES, eventIndex);
      validateEnvelope(record, eventIndex);
      return record as unknown as TaskEvent;
    }
    case "turnCheckpointed": {
      requireNonEmptyString(record.checkpointId, "checkpointId", eventIndex);
      requireStringOrNull(record.turnId, "turnId", eventIndex);
      requireStringOrNull(record.routeId, "routeId", eventIndex);
      if (record.files !== undefined) {
        if (!Array.isArray(record.files)) {
          throw incompleteEvent(eventIndex, "files must be an array");
        }
        record.files.forEach((entry, fileIndex) => validateFileSnapshot(entry, fileIndex, eventIndex));
      }
      validateEnvelope(record, eventIndex);
      return record as unknown as TaskEvent;
    }
    case "routeAttached": {
      validateRoute(record.route, eventIndex);
      validateEnvelope(record, eventIndex);
      return record as unknown as TaskEvent;
    }
    case "turnPrepared":
    case "turnCommitted": {
      requireNonEmptyString(record.turnId, "turnId", eventIndex);
      requireNonEmptyString(record.checkpointId, "checkpointId", eventIndex);
      requireNonEmptyString(record.routeId, "routeId", eventIndex);
      if (record.role !== undefined) requireEnumValue(record.role, "role", new Set(["user", "assistant"]), eventIndex);
      if (record.prompt !== undefined && typeof record.prompt !== "string") throw incompleteEvent(eventIndex, "prompt must be a string");
      if (record.parentCheckpointId !== undefined) requireNonEmptyString(record.parentCheckpointId, "parentCheckpointId", eventIndex);
      validateEnvelope(record, eventIndex);
      return record as unknown as TaskEvent;
    }
    // Change-capture/attribution events: validated for persistence safety;
    // their STATE fold (attribution decisions) belongs to plugin-task, so
    // reduceTask tracks only their envelope (lastCommittedEventId below).
    case "changeRecorded": {
      requireNonEmptyString(record.path, "path", eventIndex);
      requireEnumValue(record.source, "source", CHANGE_SOURCES, eventIndex);
      requireStringOrNull(record.beforeHash, "beforeHash", eventIndex);
      requireStringOrNull(record.afterHash, "afterHash", eventIndex);
      validateEnvelope(record, eventIndex);
      return record as unknown as TaskEvent;
    }
    case "attributionPending":
    case "attributionConflict": {
      requirePathList(record.paths, "paths", eventIndex);
      validateEnvelope(record, eventIndex);
      return record as unknown as TaskEvent;
    }
    case "attributionResolved": {
      requireNonEmptyString(record.path, "path", eventIndex);
      requireEnumValue(record.attribution, "attribution", ATTRIBUTIONS, eventIndex);
      requireEnumValue(record.status, "status", ATTRIBUTION_RESOLUTION_STATUSES, eventIndex);
      requireStringOrNull(record.protectedHash, "protectedHash", eventIndex);
      validateEnvelope(record, eventIndex);
      return record as unknown as TaskEvent;
    }
    case "conflictResolved": {
      requireNonEmptyString(record.path, "path", eventIndex);
      requireEnumValue(record.attribution, "attribution", ATTRIBUTIONS, eventIndex);
      validateEnvelope(record, eventIndex);
      return record as unknown as TaskEvent;
    }
    case "hunkReviewed": {
      requireNonEmptyString(record.routeId, "routeId", eventIndex);
      requireNonEmptyString(record.hunkRef, "hunkRef", eventIndex);
      requireEnumValue(record.status, "status", new Set(["accepted", "restored"]), eventIndex);
      validateEnvelope(record, eventIndex);
      return record as unknown as TaskEvent;
    }
    case "activeRouteChanged": {
      requireNonEmptyString(record.routeId, "routeId", eventIndex);
      validateEnvelope(record, eventIndex);
      return record as unknown as TaskEvent;
    }
    case "validationOverride": {
      if (typeof record.validationResult !== "object" || record.validationResult === null || Array.isArray(record.validationResult)) {
        throw incompleteEvent(eventIndex, "validationResult must be an object");
      }
      const result = record.validationResult as Record<string, unknown>;
      if (typeof result.success !== "boolean") {
        throw incompleteEvent(eventIndex, "validationResult.success must be a boolean");
      }
      if (result.message !== undefined && typeof result.message !== "string") {
        throw incompleteEvent(eventIndex, "validationResult.message must be a string");
      }
      validateEnvelope(record, eventIndex);
      return record as unknown as TaskEvent;
    }
    default:
      throw new TaskRecoveryError({
        kind: "unknown-event",
        eventIndex,
        reason: "event type is not a known task event",
        rawType: rawType ?? (record.type === undefined ? "undefined" : String(record.type)),
      });
  }
}

/**
 * Pure fold over a task event log: `events -> TaskState`. Status, the
 * active route and the last committed event id are all derived here —
 * callers must never write them by hand. Unknown or structurally invalid
 * events throw a structured {@link TaskRecoveryError} instead of being
 * skipped.
 */
export function reduceTask(events: readonly TaskEvent[]): TaskState {
  let head: TaskHead | null = null;
  let routes: ReadonlyMap<string, Route> = new Map();
  let checkpoints: ReadonlyMap<string, Checkpoint> = new Map();
  let turns: ReadonlyMap<string, TaskTurn> = new Map();

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = validateTaskEvent(events[eventIndex], eventIndex);
    if (event.type === "taskCreated") {
      if (head !== null) {
        throw incompleteEvent(eventIndex, "taskCreated must be the first event of the log");
      }
      head = createTaskHead({
        taskId: event.taskId,
        sessionId: event.sessionId,
        workspaceRoot: event.workspaceRoot,
        workspaceKind: event.workspaceKind,
        mode: event.mode,
        activeRouteId: event.routeId,
      });
      routes = attachRoute(
        routes,
        createRoute({
          routeId: event.routeId,
          parentRouteId: null,
          checkpointId: event.baselineCheckpointId,
          workspaceRoot: event.workspaceRoot,
          baseCommit: event.baseCommit,
        }),
      );
    } else {
      if (head === null) {
        throw incompleteEvent(eventIndex, "event log must start with taskCreated");
      }
      if (event.type === "taskStatus") {
        head = withTaskStatus(head, event.status);
      } else if (event.type === "turnCheckpointed") {
        const checkpoint = createCheckpoint({
          checkpointId: event.checkpointId,
          taskId: head.taskId,
          routeId: event.routeId ?? head.activeRouteId,
          turnId: event.turnId ?? "",
          files: event.files,
        });
        checkpoints = new Map(checkpoints).set(checkpoint.checkpointId, checkpoint);
      } else if (event.type === "turnPrepared") {
        // A turnId is single-use: a discarded (never committed) turn keeps its
        // prepared entry forever, so re-preparing the same id is rejected —
        // callers must mint a fresh turnId for any retry.
        if (turns.has(event.turnId)) {
          throw incompleteEvent(eventIndex, `turn ${event.turnId} is already prepared`);
        }
        turns = new Map(turns).set(event.turnId, {
          turnId: event.turnId,
          checkpointId: event.checkpointId,
          routeId: event.routeId,
          phase: "prepared",
          ...(event.role ? { role: event.role } : {}),
          ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
          ...(event.parentCheckpointId ? { parentCheckpointId: event.parentCheckpointId } : {}),
        });
      } else if (event.type === "turnCommitted") {
        const prepared = turns.get(event.turnId);
        if (prepared === undefined) {
          throw incompleteEvent(eventIndex, "turnCommitted must follow turnPrepared for the same turn");
        }
        if (prepared.phase === "committed") {
          throw incompleteEvent(eventIndex, `turn ${event.turnId} is already committed`);
        }
        if (prepared.checkpointId !== event.checkpointId) {
          throw incompleteEvent(eventIndex, "turnCommitted checkpointId does not match turnPrepared");
        }
        if (prepared.routeId !== event.routeId) {
          throw incompleteEvent(eventIndex, "turnCommitted routeId does not match turnPrepared");
        }
        turns = new Map(turns).set(event.turnId, { ...prepared, phase: "committed" });
      } else if (event.type === "routeAttached") {
        routes = attachRoute(routes, event.route);
        head = withActiveRouteId(head, event.route.routeId);
      } else if (event.type === "activeRouteChanged") {
        // Switching back to an existing route: the target must already be in
        // the DAG — an unknown route id is a corrupt log, never a switch.
        if (!routes.has(event.routeId)) {
          throw incompleteEvent(eventIndex, `activeRouteChanged references unknown route: ${event.routeId}`);
        }
        head = withActiveRouteId(head, event.routeId);
      }
      // changeRecorded / attribution* / hunkReviewed / validationOverride
      // events fold no core state here — their interpretation belongs to
      // plugin-task (attribution) and the command service (review/gates);
      // only the envelope advances (lastCommittedEventId below).
    }
    if (event.eventId !== undefined) {
      head = withLastCommittedEventId(head, event.eventId);
    }
  }

  if (head === null) {
    throw incompleteEvent(0, "event log must start with taskCreated");
  }
  return { ...head, routes, checkpoints, turns };
}
