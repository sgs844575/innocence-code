import { describe, expect, it } from "vitest";
import { appendRoute, attachRoute, createRoute } from "../src/index";

describe("createRoute", () => {
  it("fills route defaults", () => {
    const route = createRoute({ routeId: "r1", parentRouteId: null, checkpointId: "c0" });
    expect(route).toEqual({
      routeId: "r1",
      parentRouteId: null,
      forkTurnId: null,
      checkpointId: "c0",
      workspaceRoot: "",
      readonly: false,
    });
  });
});

describe("route DAG", () => {
  it("rejects a route cycle", () => {
    const first = createRoute({ routeId: "r1", parentRouteId: null, checkpointId: "c0" });
    const second = createRoute({ routeId: "r2", parentRouteId: "r1", checkpointId: "c1" });
    expect(() => attachRoute(first, { ...second, parentRouteId: "r2" })).toThrow("route cycle");
  });

  it("rejects longer cycles through the existing map", () => {
    const r1 = createRoute({ routeId: "r1", parentRouteId: null, checkpointId: "c0" });
    const r2 = createRoute({ routeId: "r2", parentRouteId: "r1", checkpointId: "c1" });
    const r3 = createRoute({ routeId: "r3", parentRouteId: "r2", checkpointId: "c2" });
    const routes = attachRoute(attachRoute(r1, r2), r3);
    const cyclic = createRoute({ routeId: "r1", parentRouteId: "r3", checkpointId: "c3" });
    expect(() => attachRoute(routes, cyclic)).toThrow("route cycle");
  });

  it("returns a new map and keeps the single-route input untouched", () => {
    const first = createRoute({ routeId: "r1", parentRouteId: null, checkpointId: "c0" });
    const second = createRoute({ routeId: "r2", parentRouteId: "r1", checkpointId: "c1" });
    const routes = attachRoute(first, second);
    expect(routes.size).toBe(2);
    expect(routes.get("r1")).toBe(first);
    expect(routes.get("r2")).toBe(second);
    expect(first.parentRouteId).toBeNull();
  });

  it("does not mutate an existing routes map", () => {
    const r1 = createRoute({ routeId: "r1", parentRouteId: null, checkpointId: "c0" });
    const r2 = createRoute({ routeId: "r2", parentRouteId: "r1", checkpointId: "c1" });
    const base = attachRoute(r1, r2);
    const r3 = createRoute({ routeId: "r3", parentRouteId: "r2", checkpointId: "c2" });
    const next = attachRoute(base, r3);
    expect(next.size).toBe(3);
    expect(base.size).toBe(2);
    expect(base.has("r3")).toBe(false);
  });

  it("exposes appendRoute as an alias of attachRoute", () => {
    expect(appendRoute).toBe(attachRoute);
  });
});
