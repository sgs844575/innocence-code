/**
 * plugin-task event vocabulary: the shared @innocencecode/task-core events
 * plus the change-capture and attribution events this plugin appends through
 * the TaskRuntimePort. The plugin event TYPES moved into task-core's union
 * (Task 6): the task event log is a single log, so reduceTask accepts every
 * type the port appends and one recovery replays them all. The attribution
 * INTERPRETATION stays in plugin-task (attribution.ts) — task-core persists
 * and validates the shapes.
 *
 * Events are JSON-safe and persistence-safe by the same rules as core task
 * events (paths are workspace-relative; hashes, never content). The optional
 * envelope fields are left unset by the middleware so the port's persistence
 * layer stamps identity if it needs one.
 */
import type { TaskEvent as CoreTaskEvent } from "@innocencecode/task-core";

export type {
  ChangeRecordedEvent,
  AttributionPendingEvent,
  AttributionConflictEvent,
  AttributionResolvedEvent,
  TaskChangeSource,
  TaskAttribution,
} from "@innocencecode/task-core";

/** Union appended through {@link TaskRuntimePort.append}. */
export type TaskEvent = CoreTaskEvent;
