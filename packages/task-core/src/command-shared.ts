/**
 * Shared query/mutation helpers of the TaskCommandService (split out of
 * command-service.ts): event-log access, route resolution, expectedVersion
 * CAS, durable appends, checkpoint-vs-workspace patches, statused hunks and
 * the fork orchestration wrapper. Pure over the injected ports.
 */
import type { TaskEvent } from "./events";
import { reduceTask, type TaskState } from "./reducer";
import type { Hunk, Route } from "./model";
import { TaskCommandError } from "./command-ports";
import type { TaskCommandDeps } from "./command-types";
import type { TaskForkCommand } from "./command-ports";
import type { ForkRequest } from "./fork";
import { isGitInternal, routeSummary, versionOf } from "./command-types";

export async function eventsOf(deps: TaskCommandDeps, taskId: string): Promise<TaskEvent[]> {
  const events = await deps.store.listEvents(taskId);
  if (events.length === 0) {
    throw new TaskCommandError("task-not-found", `task not found: ${taskId}`);
  }
  return events;
}

export async function stateOf(deps: TaskCommandDeps, taskId: string): Promise<TaskState> {
  return reduceTask(await eventsOf(deps, taskId));
}

export function routeOf(state: TaskState, routeId: string): Route {
  const route = state.routes.get(routeId);
  if (route === undefined) {
    throw new TaskCommandError("route-not-found", `route not found: ${routeId} in task ${state.taskId}`);
  }
  return route;
}

export function assertVersion(expected: string | undefined, events: readonly TaskEvent[]): void {
  if (expected !== undefined && expected !== versionOf(events)) {
    throw new TaskCommandError(
      "version-conflict",
      `task version conflict: expected ${expected}, current ${versionOf(events)}`,
    );
  }
}

export async function appendDurable(
  deps: TaskCommandDeps,
  taskId: string,
  events: readonly TaskEvent[],
): Promise<void> {
  await deps.store.appendEvents(taskId, events);
  for (const event of events) deps.onEvent?.(taskId, event);
}

/** Checkpoint-vs-workspace patches for one route. */
export async function patchesOf(
  deps: TaskCommandDeps,
  taskId: string,
  _state: TaskState,
  route: Route,
): Promise<import("./command-ports").TaskFilePatch[]> {
  const checkpoint = await deps.store.readCheckpoint(taskId, route.checkpointId);
  if (checkpoint === null) {
    throw new TaskCommandError("invalid-request", `checkpoint not found: ${route.checkpointId}`);
  }
  const scan = await deps.workspace.scan(route.workspaceRoot);
  return deps.diff.diff({
    before: {
      files: checkpoint.files,
      readContent: (hash) => deps.store.getObject(taskId, hash),
    },
    after: { root: scan.root, files: scan.files.filter((file) => !isGitInternal(file.path)) },
  });
}

/** Hunks with persisted review statuses and attribution-conflict marks applied. */
export async function statusedHunks(
  deps: TaskCommandDeps,
  taskId: string,
  state: TaskState,
  route: Route,
  events: readonly TaskEvent[],
): Promise<Hunk[]> {
  const patches = await patchesOf(deps, taskId, state, route);
  const decisions = deps.attribution.decisions(events);
  const conflictedPaths = new Set(
    decisions.filter((decision) => decision.status === "conflict" || decision.status === "attribution-pending" || decision.status === "candidate")
      .map((decision) => decision.path),
  );
  const reviewed = new Map<string, "accepted" | "restored">();
  for (const event of events) {
    if (event.type === "hunkReviewed" && event.routeId === route.routeId) {
      reviewed.set(event.hunkRef, event.status);
    }
  }
  return patches.flatMap((patch) =>
    patch.hunks.map((hunk) => ({
      ...hunk,
      status: conflictedPaths.has(hunk.path)
        ? ("conflict" as const)
        : reviewed.get(hunk.ref) ?? hunk.status,
    })),
  );
}

export function getOf(state: TaskState): Omit<import("./command-types").TaskGetResult, "unreviewedChanges"> {
  return {
    taskId: state.taskId,
    sessionId: state.sessionId,
    status: state.status,
    activeRouteId: state.activeRouteId,
    mode: state.mode,
    workspaceKind: state.workspaceKind,
    version: state.lastCommittedEventId ?? undefined,
  };
}

export async function withUnreviewed(
  deps: TaskCommandDeps,
  taskId: string,
  state: TaskState,
): Promise<import("./command-types").TaskGetResult> {
  const route = routeOf(state, state.activeRouteId);
  const events = await eventsOf(deps, taskId);
  const hunks = await statusedHunks(deps, taskId, state, route, events);
  return {
    ...getOf(state),
    unreviewedChanges: hunks.filter((hunk) => hunk.status !== "accepted" && hunk.status !== "restored").length,
  };
}

export async function forkWith(
  deps: TaskCommandDeps,
  request: TaskForkCommand,
  resolve: (state: TaskState) => { parentRouteId: string; sourceTurnId: string; checkpointId: string; prompt: string },
  mode: "edit-user" | "retry-assistant",
): Promise<import("./command-types").TaskForkResult> {
  const state = await stateOf(deps, request.taskId);
  if (state.sessionId !== request.sessionId) {
    throw new TaskCommandError("session-scope", "forkRoute session scope");
  }
  const resolved: ForkRequest = resolve(state);
  const result = await deps.fork.createForkedRoute({ taskId: request.taskId, mode, request, resolved, state });
  const nextState = await stateOf(deps, request.taskId);
  return {
    route: { ...routeSummary(nextState, result.route), workspaceRoot: result.route.workspaceRoot },
    prompt: result.prompt,
  };
}
