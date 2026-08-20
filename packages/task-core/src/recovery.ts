import type { TaskEvent } from "./events";
import { reduceTask, TaskRecoveryError, type TaskState } from "./reducer";

/**
 * Result of replaying raw event-log text: the reduced state (so
 * `lastCommittedEventId` and the turn phases are directly readable), the
 * complete records that were replayed, and whether a truncated tail was
 * ignored.
 */
export interface TaskRecoveryResult extends TaskState {
  readonly recoveredEvents: readonly TaskEvent[];
  readonly truncatedTail: boolean;
}

/**
 * Crash-recovery replay over the raw text of an events.jsonl file.
 *
 * Rules:
 * - Records are line-delimited JSON; each complete record is validated and
 *   replayed through {@link reduceTask}.
 * - A FINAL record whose JSON syntax is incomplete (a crash mid-append) is
 *   ignored and reported through `truncatedTail`.
 * - A malformed NON-final line is never skipped: it surfaces as a structured
 *   {@link TaskRecoveryError} so callers fail closed instead of guessing.
 * - A log without a valid taskCreated prefix throws (same as reduceTask).
 */
export function recoverTask(raw: string): TaskRecoveryResult {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const events: TaskEvent[] = [];

  for (let recordIndex = 0; recordIndex < lines.length; recordIndex += 1) {
    const line = lines[recordIndex]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (recordIndex === lines.length - 1) {
        return { ...reduceTask(events), recoveredEvents: events, truncatedTail: true };
      }
      throw new TaskRecoveryError({
        kind: "incomplete-event",
        eventIndex: recordIndex,
        reason: `record is not valid JSON: ${String(error)}`,
      });
    }
    events.push(parsed as TaskEvent);
  }

  return { ...reduceTask(events), recoveredEvents: events, truncatedTail: false };
}
