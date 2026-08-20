/**
 * Pure text renderers for CLI review output (Task 13). Every function
 * RETURNS structured lines (or plain strings) — nothing here writes stdout;
 * the adapter forwards rendered lines through the injected output port.
 */
import type {
  Hunk,
  TaskApplyConflict,
  TaskFilePatch,
  TaskGetResult,
  TaskRouteSummaryDto,
} from "@innocencecode/task-core";

export interface TaskCliOutputLine {
  kind:
    | "task"
    | "route"
    | "change"
    | "hunk"
    | "conflict"
    | "warning"
    | "status";
  text: string;
}

const line = (kind: TaskCliOutputLine["kind"], text: string): TaskCliOutputLine => ({ kind, text });

const shortHash = (hash: string | null): string => (hash === null ? "-" : hash.slice(0, 10));

export function renderTaskSummary(task: TaskGetResult): TaskCliOutputLine[] {
  return [
    line("task", `task ${task.taskId} [${task.status}] session ${task.sessionId}`),
    line("task", `mode ${task.mode} workspace ${task.workspaceKind} active route ${task.activeRouteId}`),
    line("task", `version ${task.version ?? "(none)"} unreviewed changes ${task.unreviewedChanges}`),
  ];
}

export function renderRoutes(routes: readonly TaskRouteSummaryDto[]): TaskCliOutputLine[] {
  return routes.map((route) =>
    line(
      "route",
      `route ${route.routeId} parent ${route.parentRouteId ?? "-"} forked-at ${
        route.forkTurnId ?? "-"
      } checkpoint ${route.checkpointId} [${route.workspaceKind}]`,
    ),
  );
}

export function renderChanges(changes: readonly TaskFilePatch[]): TaskCliOutputLine[] {
  return changes.map((change) =>
    line(
      "change",
      `${change.path}: ${shortHash(change.before.hash)} -> ${shortHash(change.after.hash)}${
        change.binary ? " (binary)" : ` (${change.hunks.length} hunks)`
      }`,
    ),
  );
}

export function renderHunks(hunks: readonly Hunk[]): TaskCliOutputLine[] {
  return hunks.flatMap((hunk) => [
    line("hunk", `${hunk.path}  [${hunk.status}]  ref ${hunk.ref.slice(0, 12)}`),
    ...hunk.before.split("\n").filter((part) => part !== "").map((part) => line("hunk", `  - ${part}`)),
    ...hunk.after.split("\n").filter((part) => part !== "").map((part) => line("hunk", `  + ${part}`)),
  ]);
}

export function renderConflicts(conflicts: readonly TaskApplyConflict[]): TaskCliOutputLine[] {
  return conflicts.map((conflict) =>
    line(
      "conflict",
      `${conflict.path}: expected ${shortHash(conflict.expected)}, found ${shortHash(conflict.actual)}`,
    ),
  );
}

export function renderWarnings(warnings: readonly string[]): TaskCliOutputLine[] {
  return warnings.map((warning) => line("warning", warning));
}
