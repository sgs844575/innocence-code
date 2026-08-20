import type { TaskEvent as CoreTaskEvent, TaskEventEnvelope } from "@innocencecode/task-core";
import type { Attribution, ChangeSource } from "./attribution";

/**
 * plugin-task event vocabulary: the shared @innocencecode/task-core events
 * plus the change-capture and attribution events this plugin appends through
 * the TaskRuntimePort. Events are JSON-safe and persistence-safe by the same
 * rules as core task events (paths are workspace-relative; hashes, never
 * content). The optional envelope fields are left unset by the middleware so
 * the port's persistence layer stamps identity if it needs one.
 */

/** One captured change to a declared write target. */
export interface ChangeRecordedEvent extends TaskEventEnvelope {
  type: "changeRecorded";
  path: string;
  source: ChangeSource;
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
  attribution: Attribution;
  status: "pending-review" | "excluded";
  protectedHash: string | null;
}

/** Union appended through {@link TaskRuntimePort.append}. */
export type TaskEvent =
  | CoreTaskEvent
  | ChangeRecordedEvent
  | AttributionPendingEvent
  | AttributionConflictEvent
  | AttributionResolvedEvent;
