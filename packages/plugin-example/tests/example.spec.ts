import { Context, FiberState } from "@innocencecode/kernel";
import ExamplePlugin, { ExamplePlugin as namedExport } from "@innocencecode/plugin-example";
import { describe, expect, it } from "vitest";

// The example plugin announces itself through the kernel event catalog;
// consumers type the payload through declaration merging, the same way
// kernel-logger's tests extend `Context`.
declare module "@innocencecode/kernel" {
  interface Events {
    "example/ready"(payload: { greeting: string }): void;
  }
}

describe("example plugin", () => {
  it("activates into an ACTIVE fiber", async () => {
    const ctx = new Context();
    const fiber = await ctx.plugin(ExamplePlugin);
    expect(fiber.state).toBe(FiberState.ACTIVE);
  });

  it("announces readiness while applying", async () => {
    const ctx = new Context();
    const seen: { greeting: string }[] = [];
    // `apply` runs synchronously inside ctx.plugin, so the listener must
    // be registered before loading to observe the one-shot ready event.
    ctx.on("example/ready", (payload) => { seen.push(payload); });
    await ctx.plugin(ExamplePlugin);
    expect(seen).toEqual([{ greeting: "installed" }]);
  });

  it("keeps the template shape on the default and named export", () => {
    expect(ExamplePlugin.name).toBe("example");
    expect(typeof ExamplePlugin.apply).toBe("function");
    expect(namedExport).toBe(ExamplePlugin);
  });
});
