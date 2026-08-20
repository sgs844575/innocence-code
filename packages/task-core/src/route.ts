import type { Route } from "./model";

/** Immutable view of the route DAG keyed by routeId. */
export type RouteMap = ReadonlyMap<string, Route>;

export interface CreateRouteInput {
  routeId: string;
  parentRouteId: string | null;
  checkpointId: string;
  forkTurnId?: string | null;
  workspaceRoot?: string;
  readonly?: boolean;
  baseCommit?: string;
}

/** Creates a writable top-level route unless fork fields say otherwise. */
export function createRoute(input: CreateRouteInput): Route {
  return {
    routeId: input.routeId,
    parentRouteId: input.parentRouteId,
    forkTurnId: input.forkTurnId ?? null,
    checkpointId: input.checkpointId,
    workspaceRoot: input.workspaceRoot ?? "",
    readonly: input.readonly ?? false,
    ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
  };
}

function toRouteMap(base: Route | RouteMap): Map<string, Route> {
  if (typeof base === "object" && base !== null && "routeId" in base) {
    return new Map<string, Route>([[base.routeId, base]]);
  }
  return new Map<string, Route>(base);
}

/**
 * Walks the parent chain of `route` upward through the known routes and
 * throws an Error containing "route cycle" if `route` would close a loop.
 * An unknown parent id simply ends the walk (the parent is not attached yet).
 */
function assertNoRouteCycle(routes: ReadonlyMap<string, Route>, route: Route): void {
  const visited = new Set<string>([route.routeId]);
  let currentId: string | null = route.parentRouteId;
  while (currentId !== null) {
    if (visited.has(currentId)) {
      throw new Error(`route cycle detected: ${route.routeId} -> ${currentId}`);
    }
    visited.add(currentId);
    const parent = routes.get(currentId);
    if (parent === undefined) {
      return;
    }
    currentId = parent.parentRouteId;
  }
}

/**
 * Attaches `route` to the DAG rooted in `base` — either a single existing
 * route (treated as a one-route graph) or the full route map used by the
 * reducer. Returns a NEW map; the inputs are never mutated.
 */
export function attachRoute(base: Route | RouteMap, route: Route): RouteMap {
  const routes = toRouteMap(base);
  assertNoRouteCycle(routes, route);
  routes.set(route.routeId, route);
  return routes;
}

/** Alias kept for the plan's `appendRoute` naming; same function, same checks. */
export const appendRoute = attachRoute;
