/**
 * Attribution state machine for workspace changes observed while a task runs
 * (P1 plan, fixed transitions):
 *
 *   candidate → attribution-pending
 *   attribution-pending + task-owned → pending review
 *   attribution-pending + external → excluded + protected external version
 *   candidate overlap with expected write → conflict
 *
 * Pure functions only: persistence and enforcement live behind the
 * TaskRuntimePort (real implementation wired by Task 6); this package
 * orchestrates the port and exposes the decisions. While any decision is
 * unresolved (candidate, attribution-pending or conflict) the capture
 * middleware blocks new write tools, and hosts must apply the same gate to
 * task completion. Externally attributed paths carry a protected content
 * hash and must never be touched by task restore/apply (enforced in
 * Tasks 5/6 via {@link excludedPaths}).
 *
 * The ChangeSource/Attribution unions are task-core's canonical vocabulary
 * (single-sourced with the persisted event types — see
 * task-core/src/events.ts).
 */
import type { TaskAttribution, TaskChangeSource, TaskEvent } from "@innocencecode/task-core";

/** Where a captured change came from (task-core's canonical union). */
export type ChangeSource = TaskChangeSource;

export type AttributionStatus =
  | "candidate" // changed path detected, attribution not yet requested
  | "attribution-pending" // paused, waiting for the user to attribute the change
  | "pending-review" // user attributed it to the task → joins the review set
  | "excluded" // user attributed it to an external actor
  | "conflict"; // change overlaps a declared (expected) task write

/** The user's answer to an attribution request (task-core's canonical union). */
export type Attribution = TaskAttribution;

/** A changed path as observed by the watcher or a before/after workspace scan. */
export interface ObservedChange {
  readonly path: string;
  readonly source: "unknown";
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
}

/** One tracked attribution decision. Instances are immutable; transitions return new objects. */
export interface AttributionDecision {
  readonly path: string;
  readonly status: AttributionStatus;
  readonly source: ChangeSource;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  /**
   * Content hash of the externally attributed version. Once set, restore and
   * apply must never touch this path — the recorded version is protected.
   */
  readonly protectedHash: string | null;
}

/** Resolved decision shapes (the two terminal outcomes of the pending state). */
export interface PendingReviewDecision extends AttributionDecision {
  readonly status: "pending-review";
}

export interface ExcludedDecision extends AttributionDecision {
  readonly status: "excluded";
  readonly protectedHash: string;
}

const UNRESOLVED_STATUSES: readonly AttributionStatus[] = [
  "candidate",
  "attribution-pending",
  "conflict",
];

/** candidate → attribution-pending. */
export function toAttributionPending(change: ObservedChange): AttributionDecision {
  return {
    path: change.path,
    status: "attribution-pending",
    source: change.source,
    beforeHash: change.beforeHash,
    afterHash: change.afterHash,
    protectedHash: null,
  };
}

function requireAttributionPending(decision: AttributionDecision): void {
  if (decision.status !== "attribution-pending") {
    throw new Error(
      `attribution: cannot resolve ${decision.path} from status "${decision.status}" ` +
        "(only attribution-pending decisions can be resolved)",
    );
  }
}

/** attribution-pending + task-owned → pending review. */
export function resolveAsTaskOwned(decision: AttributionDecision): PendingReviewDecision {
  requireAttributionPending(decision);
  return { ...decision, status: "pending-review", protectedHash: null };
}

/** attribution-pending + external → excluded + protected external version. */
export function resolveAsExternal(decision: AttributionDecision): ExcludedDecision {
  requireAttributionPending(decision);
  return {
    ...decision,
    status: "excluded",
    // An external deletion protects the absent state ("" = "must stay absent");
    // any other content is protected by its exact hash.
    protectedHash: decision.afterHash ?? "",
  };
}

/**
 * candidate overlap with expected write → conflict. Partitions unknown-source
 * changes of one capture window: those overlapping the invocation's declared
 * (expected) write targets conflict, the rest pause for attribution.
 */
export function classifyUnknownChanges(
  changes: readonly ObservedChange[],
  expectedWritePaths: readonly string[],
): { conflicts: readonly ObservedChange[]; pending: readonly ObservedChange[] } {
  const expected = new Set(expectedWritePaths);
  const conflicts: ObservedChange[] = [];
  const pending: ObservedChange[] = [];
  for (const change of changes) {
    (expected.has(change.path) ? conflicts : pending).push(change);
  }
  return { conflicts, pending };
}

/** True while any decision still requires user attribution (or a conflict to clear). */
export function hasUnresolvedAttribution(decisions: readonly AttributionDecision[]): boolean {
  return decisions.some((decision) => UNRESOLVED_STATUSES.includes(decision.status));
}

/** Paths whose attribution is still unresolved (blocks new write tools). */
export function unresolvedPaths(decisions: readonly AttributionDecision[]): string[] {
  return decisions
    .filter((decision) => UNRESOLVED_STATUSES.includes(decision.status))
    .map((decision) => decision.path);
}

/**
 * Externally attributed paths: the exclusion surface for restore/apply
 * candidate sets (their recorded version is protected and must not be
 * touched by task recovery).
 */
export function excludedPaths(decisions: readonly AttributionDecision[]): string[] {
  return decisions.filter((decision) => decision.status === "excluded").map((decision) => decision.path);
}

/**
 * Folds a task event log into the current attribution decisions (Task 13;
 * moved from the host so every host — Electron bridge and CLI — folds the
 * SAME way): pending/conflict events track or harden a path, attributionResolved
 * and conflictResolved land in their terminal status. Hashes stay null when
 * the persisted event carries none — the gate never reads them.
 */
export function foldAttributionDecisions(events: readonly TaskEvent[]): AttributionDecision[] {
  const decisions = new Map<string, AttributionDecision>();
  const absorb = (path: string, status: AttributionStatus, protectedHash: string | null): void => {
    const prev = decisions.get(path);
    decisions.set(path, {
      path,
      status,
      source: prev?.source ?? "unknown",
      beforeHash: prev?.beforeHash ?? null,
      afterHash: prev?.afterHash ?? null,
      protectedHash,
    });
  };
  for (const event of events) {
    if (event.type === "attributionPending") {
      for (const path of event.paths) absorb(path, "attribution-pending", null);
    } else if (event.type === "attributionConflict") {
      for (const path of event.paths) absorb(path, "conflict", null);
    } else if (event.type === "attributionResolved") {
      absorb(event.path, event.status, event.protectedHash);
    } else if (event.type === "conflictResolved") {
      // the explicit conflict-resolution transition (Task 13): same terminal
      // statuses as attributionResolved — this is what clears the write block
      const prev = decisions.get(event.path);
      absorb(
        event.path,
        event.attribution === "task-owned" ? "pending-review" : "excluded",
        event.attribution === "external" ? prev?.afterHash ?? "" : null,
      );
    }
    // changeRecorded events fold no decision: a DECLARED write is the task's
    // own change (never unresolved); only attribution* events gate writes.
  }
  return [...decisions.values()];
}
