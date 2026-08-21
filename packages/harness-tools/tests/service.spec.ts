import { Context } from "@innocencecode/kernel";
import {
  ToolsPlugin,
  type Tool,
  type ToolExecutionMiddleware,
  type ToolsService,
} from "@innocencecode/harness-tools";
import { describe, expect, expectTypeOf, it } from "vitest";

// Mirrors kernel-logger's test setup: load the plugin into a fresh kernel
// context; `ctx.tools` is live while the plugin fiber is active.
async function withTools(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(ToolsPlugin);
  return ctx;
}

function completeTool(name: string): Tool {
  return {
    name,
    description: name,
    readOnly: true,
    parameters: { type: "object" },
    permissionResource: () => ({ action: "read", kind: "test", scope: name }),
    persistArgs: () => ({}),
    execute: async () => ({ content: "ok" }),
  };
}

describe("tool persistence policy (fail-closed SPI gate)", () => {
  it("accepts tools that implement permissionResource and persistArgs", async () => {
    const ctx = await withTools();
    ctx.tools.register(completeTool("Good"));
    expect(ctx.tools.get("Good")?.name).toBe("Good");
  });

  it("rejects tools without permissionResource with tool-persistence-policy-required", async () => {
    const ctx = await withTools();
    const broken = completeTool("NoResource") as unknown as Record<string, unknown>;
    delete broken.permissionResource;
    let caught: { code?: string; message?: string } | undefined;
    try {
      ctx.tools.register(broken as unknown as Tool);
    } catch (err) {
      caught = err as { code?: string; message?: string };
    }
    expect(caught?.code).toBe("tool-persistence-policy-required");
    expect(caught?.message).toContain("NoResource");
    expect(caught?.message).toContain("permissionResource");
    expect(ctx.tools.get("NoResource")).toBeUndefined();
  });

  it("rejects tools without persistArgs with tool-persistence-policy-required", async () => {
    const ctx = await withTools();
    const broken = completeTool("NoPersist") as unknown as Record<string, unknown>;
    delete broken.persistArgs;
    let caught: { code?: string; message?: string } | undefined;
    try {
      ctx.tools.register(broken as unknown as Tool);
    } catch (err) {
      caught = err as { code?: string; message?: string };
    }
    expect(caught?.code).toBe("tool-persistence-policy-required");
    expect(caught?.message).toContain("NoPersist");
    expect(caught?.message).toContain("persistArgs");
    expect(ctx.tools.get("NoPersist")).toBeUndefined();
  });

  it("rejects duplicate tool names", async () => {
    const ctx = await withTools();
    ctx.tools.register(completeTool("Twin"));
    expect(() => ctx.tools.register(completeTool("Twin"))).toThrow(
      "duplicate tool registration: Twin",
    );
    expect(ctx.tools.get("Twin")?.description).toBe("Twin");
  });

  it("exposes registered tools as provider-facing specs", async () => {
    const ctx = await withTools();
    ctx.tools.register(completeTool("A"));
    ctx.tools.register({ ...completeTool("B"), readOnly: false });
    expect(ctx.tools.specs()).toEqual([
      { name: "A", description: "A", readOnly: true, parameters: { type: "object" } },
      { name: "B", description: "B", readOnly: false, parameters: { type: "object" } },
    ]);
  });
});

describe("tool execution middleware registration", () => {
  const layer = (name: string): ToolExecutionMiddleware => ({
    name,
    async execute(_invocation, next) {
      return next();
    },
  });

  it("registers middleware in registration order", async () => {
    const ctx = await withTools();
    ctx.tools.registerMiddleware(layer("outer"));
    ctx.tools.registerMiddleware(layer("inner"));
    expect(ctx.tools.middlewares().map((m) => m.name)).toEqual(["outer", "inner"]);
  });

  it("middlewares exposes a readonly view (type-level gate)", async () => {
    const ctx = await withTools();
    expectTypeOf(ctx.tools.middlewares()).toEqualTypeOf<readonly ToolExecutionMiddleware[]>();
  });
});

describe("tools service lifecycle on the kernel", () => {
  it("publishes the tools service under \"tools\" while its fiber is active", async () => {
    const ctx = await withTools();
    expect((ctx as { tools?: ToolsService }).tools).toBeDefined();
    ctx.tools.register(completeTool("Good"));
    expect(ctx.tools.get("Good")?.name).toBe("Good");
  });

  it("withdraws the service when the plugin fiber is disposed", async () => {
    const ctx = new Context();
    const fiber = await ctx.plugin(ToolsPlugin);
    const service = ctx.tools;
    ctx.tools.register(completeTool("Good"));
    await fiber.dispose();
    // The withdraw handle returned by `apply` removed the context property;
    // the detached service object stays inert but usable.
    expect((ctx as { tools?: ToolsService }).tools).toBeUndefined();
    expect(() => service.register(completeTool("Late"))).not.toThrow();
  });
});
