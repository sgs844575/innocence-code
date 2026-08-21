import { Context } from "@innocencecode/kernel";
import { describe, expect, it } from "vitest";

declare module "@innocencecode/kernel" {
  interface Events {
    "internal/unwind-error"(payload: { fiberId: number | null; label: string | undefined; errors: unknown[] }): void;
  }
}

describe("unwind error aggregation", () => {
  it("collects disposer errors, keeps unwinding, and reports via event", async () => {
    const ctx = new Context();
    const reported: Array<{ fiberId: number | null; errors: unknown[] }> = [];
    ctx.on("internal/unwind-error", (p) => { reported.push(p); });
    let ran = false;
    const fiber = await ctx.plugin({
      name: "boom-cleanup",
      apply(ctx) {
        ctx.effect(() => () => { throw new Error("first"); }, "a");
        ctx.effect(() => () => { ran = true; }, "b");
      },
    });
    await fiber.dispose(); // 不 reject
    expect(ran).toBe(true);
    expect(fiber.unwindErrors).toHaveLength(1);
    expect(reported).toHaveLength(1);
    expect(reported[0].errors[0]).toBeInstanceOf(Error);
    expect(reported[0].fiberId).toBe(fiber.uid);
  });

  it("emits nothing and yields an empty array when cleanup is clean", async () => {
    const ctx = new Context();
    let events = 0;
    ctx.on("internal/unwind-error", () => { events += 1; });
    const fiber = await ctx.plugin({
      name: "clean",
      apply(ctx) { ctx.effect(() => () => {}); },
    });
    await fiber.dispose();
    expect(events).toBe(0);
    expect(fiber.unwindErrors).toEqual([]);
  });
});
