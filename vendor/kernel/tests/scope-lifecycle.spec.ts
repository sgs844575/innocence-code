import { Context, FiberState } from "@innocencecode/kernel";
import { describe, expect, it } from "vitest";

// Correction vs task brief: Events entries in this kernel are call-signature
// declarations (see the Events interface in the kernel core), and
// `ctx.on(name, listener: Events[K])` requires a callable event type, so
// the brief's `"reopen/ping": void` property style is not valid here.
declare module "@innocencecode/kernel" {
  interface Events {
    "reopen/ping"(): void;
  }
}

describe("plugin kernel scope lifecycle (window-reopen simulation)", () => {
  it("repeated boot/dispose cycles leave zero residue", async () => {
    for (let round = 0; round < 5; round += 1) {
      const ctx = new Context();
      let cleaned = 0;
      let delivered = 0;
      await ctx.plugin({
        name: "probe",
        apply(ctx: Context) {
          ctx.effect(() => () => { cleaned += 1; });
          ctx.on("reopen/ping", () => { delivered += 1; });
        },
      });
      ctx.emit("reopen/ping");
      expect(delivered).toBe(1);
      await ctx.fiber.dispose();
      expect(cleaned).toBe(1);
      ctx.emit("reopen/ping");
      expect(delivered).toBe(1);
      expect(ctx.fiber.getEffects()).toEqual([]);
    }
  });

  it("merges concurrent root disposals into one unwind", async () => {
    const ctx = new Context();
    let cleaned = 0;
    await ctx.plugin({
      name: "probe",
      apply(ctx: Context) {
        ctx.effect(() => () => { cleaned += 1; });
      },
    });
    await Promise.all([ctx.fiber.dispose(), ctx.fiber.dispose()]);
    expect(cleaned).toBe(1);
    // Correction vs task brief: assert against the exported FiberState enum
    // (the kernel defines `const enum FiberState`, where ACTIVE = 2) instead
    // of the raw literal 2 — identical semantics.
    expect(ctx.fiber.state).toBe(FiberState.ACTIVE);
  });
});
