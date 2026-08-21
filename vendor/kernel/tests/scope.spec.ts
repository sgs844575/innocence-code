import { Context, FiberState, createScope } from "@innocencecode/kernel";
import { describe, expect, it } from "vitest";

declare module "@innocencecode/kernel" {
  interface Context {
    /** Probe service published by the scope tests below. */
    probe?: number | string;
  }
}

describe("createScope contract", () => {
  it("gives the scope its own service table and its own fiber", () => {
    const parent = new Context();
    const scope = createScope(parent);
    // Unlike a bare derive() (which reuses the parent fiber), a scope owns a
    // fiber so its lifecycle can end independently of the parent's.
    expect(scope.ctx.fiber).not.toBe(parent.fiber);
    expect(scope.ctx.services).not.toBe(parent.services);
    expect(scope.ctx.registry).toBe(parent.registry);
    // Provide lands on the scope itself, not the parent.
    scope.ctx.provide("probe", 1);
    expect(scope.ctx.services.owns("probe")).toBe(true);
    expect(parent.services.owns("probe")).toBe(false);
    expect(scope.ctx.probe).toBe(1);
    expect(parent.probe).toBeUndefined();
  });

  it("disposes scope plugins and effects without touching the parent or siblings", async () => {
    const parent = new Context();
    const events: string[] = [];
    await parent.plugin({
      name: "parent-probe",
      apply(ctx) {
        ctx.effect(() => () => { events.push("parent"); }, "parent");
      },
    });
    const scopeA = createScope(parent);
    await scopeA.ctx.plugin({
      name: "scope-a",
      apply(ctx) {
        ctx.effect(() => () => { events.push("scope-a"); }, "a");
        ctx.effect(() => () => {}, "registered-on-scope");
      },
    });
    const scopeB = createScope(parent);
    await scopeB.ctx.plugin({
      name: "scope-b",
      apply(ctx) {
        ctx.effect(() => () => { events.push("scope-b"); }, "b");
      },
    });

    await scopeA.dispose();
    expect(events).toEqual(["scope-a"]);
    expect(scopeA.ctx.fiber.state).toBe(FiberState.DISPOSED);
    // The parent and the sibling scope keep running.
    expect(parent.fiber.state).toBe(FiberState.ACTIVE);
    expect(scopeB.ctx.fiber.state).toBe(FiberState.ACTIVE);
    await scopeB.dispose();
    await parent.fiber.dispose();
    expect(events.sort()).toEqual(["parent", "scope-a", "scope-b"]);
  });

  it("isolates sibling scopes and keeps derive shadow semantics inside a scope", () => {
    const parent = new Context();
    parent.provide("probe", 0);
    const a = createScope(parent);
    const b = createScope(parent);
    a.ctx.provide("probe", "a");
    b.ctx.provide("probe", "b");
    expect(a.ctx.probe).toBe("a");
    expect(b.ctx.probe).toBe("b");
    expect(parent.probe).toBe(0);
    // A context derived inside the scope still shares the scope's table.
    const inner = a.ctx.derive();
    expect(inner.probe).toBe("a");
    inner.provide("probe", "inner");
    expect(inner.probe).toBe("inner");
    expect(a.ctx.probe).toBe("a");
  });

  it("cascades scope disposal when the parent root unwinds", async () => {
    const parent = new Context();
    const scope = createScope(parent);
    const cleaned: string[] = [];
    await scope.ctx.plugin({
      name: "scoped",
      apply(ctx) {
        ctx.effect(() => () => { cleaned.push("plugin"); }, "plugin");
      },
    });
    scope.ctx.effect(() => () => { cleaned.push("scope"); }, "scope");
    // Root disposal runs the parent's records, which include the scope fiber.
    await parent.fiber.dispose();
    expect(cleaned.sort()).toEqual(["plugin", "scope"]);
    expect(scope.ctx.fiber.state).toBe(FiberState.DISPOSED);
  });

  it("drops scope-owned event listeners when the scope disposes", async () => {
    const parent = new Context();
    const scope = createScope(parent);
    let deliveries = 0;
    await scope.ctx.plugin({
      name: "listener",
      apply(ctx) {
        ctx.on("probe/echo", () => {
          deliveries += 1;
        });
      },
    });
    parent.emit("probe/echo", 1);
    expect(deliveries).toBe(1);
    await scope.dispose();
    parent.emit("probe/echo", 1);
    expect(deliveries).toBe(1);
  });
});
