import { Context, FiberState, KernelError } from "@innocencecode/plugin-kernel";
import { describe, expect, it } from "vitest";

declare module "@innocencecode/plugin-kernel" {
  interface Events {
    "probe/ping"(): void;
    "probe/echo"(n: number): void;
  }
}

describe("plugin kernel semantics", () => {
  it("unwinds effects in reverse order on child fiber dispose", async () => {
    const ctx = new Context();
    const order: string[] = [];
    const plugin = {
      name: "probe",
      apply(ctx: Context) {
        ctx.effect(() => () => { order.push("a"); }, "effect-a");
        ctx.effect(() => () => { order.push("b"); }, "effect-b");
      },
    };
    const fiber = await ctx.plugin(plugin);
    expect(fiber.state).toBe(FiberState.ACTIVE);
    await fiber.dispose();
    expect(order).toEqual(["b", "a"]);
    expect(fiber.state).toBe(FiberState.DISPOSED);
    expect(fiber.uid).toBe(null);
    expect(fiber.getEffects()).toEqual([]);
    expect(ctx.registry.get(plugin)).toBeUndefined();
  });

  it("isolates a failing plugin from its siblings", async () => {
    const ctx = new Context();
    const boom = { name: "boom", apply() { throw new Error("nope"); } };
    const ok = { name: "ok", apply(ctx: Context) { ctx.effect(() => () => {}); } };
    const boomFiber = ctx.plugin(boom);
    const okFiber = await ctx.plugin(ok);
    await expect(boomFiber).rejects.toThrow("nope");
    expect(okFiber.state).toBe(FiberState.ACTIVE);
    expect(ctx.registry.has(ok)).toBe(true);
    // Kernel contract: a failed fiber settles in FAILED and keeps its
    // registry runtime until it is disposed.
    expect(boomFiber.state).toBe(FiberState.FAILED);
    expect(ctx.registry.has(boom)).toBe(true);
    await boomFiber.dispose();
    expect(boomFiber.uid).toBe(null);
    expect(ctx.registry.has(boom)).toBe(false);
    expect(okFiber.state).toBe(FiberState.ACTIVE);
  });

  it("stops event delivery after unsubscribe and after fiber dispose", async () => {
    const ctx = new Context();
    const seen: number[] = [];
    const off = ctx.on("probe/echo", (n) => { seen.push(n); });
    ctx.emit("probe/echo", 1);
    // Kernel contract: the unsubscribe disposer returns void.
    expect(off()).toBeUndefined();
    ctx.emit("probe/echo", 2);
    const plugin = {
      name: "listener",
      apply(ctx: Context) {
        ctx.on("probe/echo", (n) => { seen.push(n); });
      },
    };
    const fiber = await ctx.plugin(plugin);
    ctx.emit("probe/echo", 3);
    await fiber.dispose();
    ctx.emit("probe/echo", 4);
    expect(seen).toEqual([1, 3]);
  });

  it("rejects effect registration during restart cleanup (INACTIVE_EFFECT)", async () => {
    const ctx = new Context();
    let registrationError: unknown;
    ctx.effect(() => () => {
      try { ctx.effect(() => () => {}, "too-late"); } catch (error) { registrationError = error; }
    }, "restart-cleanup");
    await ctx.fiber.restart();
    expect(registrationError).toBeInstanceOf(KernelError);
    expect((registrationError as KernelError).code).toBe("INACTIVE_EFFECT");
    expect(ctx.fiber.state).toBe(FiberState.ACTIVE);
    expect(ctx.fiber.getEffects()).toEqual([]);
  });

  it("disposes the root fiber to an empty active root, idempotently", async () => {
    const ctx = new Context();
    let cleaned = 0;
    await ctx.plugin({ name: "child", apply(ctx: Context) {
      ctx.effect(() => () => { cleaned += 1; });
    } });
    await ctx.fiber.dispose();
    await ctx.fiber.dispose();
    expect(cleaned).toBe(1);
    expect(ctx.fiber.state).toBe(FiberState.ACTIVE);
    expect(ctx.fiber.getEffects()).toEqual([]);
  });
});
