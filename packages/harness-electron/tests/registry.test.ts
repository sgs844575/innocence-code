// Legacy PluginRegistry suite (moved here with registry.ts from the retired
// core package; assertions unchanged, type imports re-pointed to the
// spine packages that own each face).
import { describe, expect, expectTypeOf, it } from "vitest";
import { PluginRegistry, type HarnessPlugin } from "../src";
import type { PolicyRule } from "@innocencecode/harness-permissions";
import type { Provider } from "@innocencecode/harness-providers";
import type { Skill } from "@innocencecode/harness-skills";
import type { Tool, ToolExecutionMiddleware } from "@innocencecode/harness-tools";

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
  it("accepts tools that implement permissionResource and persistArgs", () => {
    const registry = new PluginRegistry();
    registry.createContext("p", () => {}).registerTool(completeTool("Good"));
    expect(registry.tools.has("Good")).toBe(true);
  });

  it("rejects tools without permissionResource with tool-persistence-policy-required", () => {
    const registry = new PluginRegistry();
    const broken = completeTool("NoResource") as unknown as Record<string, unknown>;
    delete broken.permissionResource;
    let caught: { code?: string; message?: string } | undefined;
    try {
      registry.createContext("p", () => {}).registerTool(broken as unknown as Tool);
    } catch (err) {
      caught = err as { code?: string; message?: string };
    }
    expect(caught?.code).toBe("tool-persistence-policy-required");
    expect(caught?.message).toContain("NoResource");
    expect(caught?.message).toContain("permissionResource");
    expect(registry.tools.has("NoResource")).toBe(false);
  });

  it("rejects tools without persistArgs with tool-persistence-policy-required", () => {
    const registry = new PluginRegistry();
    const broken = completeTool("NoPersist") as unknown as Record<string, unknown>;
    delete broken.persistArgs;
    let caught: { code?: string; message?: string } | undefined;
    try {
      registry.createContext("p", () => {}).registerTool(broken as unknown as Tool);
    } catch (err) {
      caught = err as { code?: string; message?: string };
    }
    expect(caught?.code).toBe("tool-persistence-policy-required");
    expect(caught?.message).toContain("NoPersist");
    expect(caught?.message).toContain("persistArgs");
    expect(registry.tools.has("NoPersist")).toBe(false);
  });

  it("rolls back activated plugins when one registers a non-compliant tool", async () => {
    const calls: string[] = [];
    const plugins: HarnessPlugin[] = [
      {
        name: "a",
        activate(ctx) {
          ctx.registerTool(completeTool("A"));
        },
        async dispose() {
          calls.push("dispose-a");
        },
      },
      {
        name: "b",
        activate(ctx) {
          const broken = completeTool("B") as unknown as Record<string, unknown>;
          delete broken.persistArgs;
          ctx.registerTool(broken as unknown as Tool);
        },
      },
    ];
    const registry = new PluginRegistry();
    await expect(registry.load(plugins)).rejects.toThrow("tool-persistence-policy-required");
    expect(calls).toEqual(["dispose-a"]);
    // The rejected tool never lands in the registry.
    expect(registry.tools.has("B")).toBe(false);
  });
});

describe("tool execution middleware registration", () => {
  const layer = (name: string): ToolExecutionMiddleware => ({
    name,
    async execute(_invocation, next) {
      return next();
    },
  });

  it("registers middleware through the plugin context in registration order", async () => {
    const registry = new PluginRegistry();
    const plugin: HarnessPlugin = {
      name: "mw",
      activate(ctx) {
        ctx.registerToolMiddleware(layer("outer"));
        ctx.registerToolMiddleware(layer("inner"));
      },
    };
    await registry.load([plugin]);
    expect(registry.toolMiddlewares.map((m) => m.name)).toEqual(["outer", "inner"]);
  });

  it("registers middleware without any plugin through createContext too", () => {
    const registry = new PluginRegistry();
    registry.createContext("direct", () => {}).registerToolMiddleware(layer("only"));
    expect(registry.toolMiddlewares).toHaveLength(1);
  });
});

describe("registry tables are read-only outside the plugin context", () => {
  it("the public tables are readonly views (type-level gate)", () => {
    const registry = new PluginRegistry();
    expectTypeOf(registry.tools).toEqualTypeOf<ReadonlyMap<string, Tool>>();
    expectTypeOf(registry.providers).toEqualTypeOf<ReadonlyMap<string, Provider>>();
    expectTypeOf(registry.skills).toEqualTypeOf<ReadonlyMap<string, Skill>>();
    expectTypeOf(registry.policyRules).toEqualTypeOf<readonly PolicyRule[]>();
    expectTypeOf(registry.toolMiddlewares).toEqualTypeOf<readonly ToolExecutionMiddleware[]>();
  });

  it("the views expose exactly what was registered through the gate", () => {
    const registry = new PluginRegistry();
    const ctx = registry.createContext("p", () => {});
    ctx.registerTool(completeTool("Good"));
    ctx.registerProvider({ id: "prov", async *chat() {} });
    ctx.registerSkill({ name: "sk", description: "d", loadBody: async () => "" });
    ctx.registerPolicyRule({ name: "rule", match: () => "skip" });
    ctx.registerToolMiddleware({
      name: "mw",
      async execute(_invocation, next) {
        return next();
      },
    });
    expect(registry.tools.get("Good")?.name).toBe("Good");
    expect(registry.providers.get("prov")?.id).toBe("prov");
    expect(registry.skills.get("sk")?.name).toBe("sk");
    expect(registry.policyRules).toHaveLength(1);
    expect(registry.toolMiddlewares.map((m) => m.name)).toEqual(["mw"]);
  });
});

describe("PluginRegistry lifecycle", () => {
  it("disposes activated plugins once in reverse order", async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry();
    await registry.load([
      { name: "a", activate() { calls.push("activate-a"); }, async dispose() { calls.push("dispose-a"); } },
      { name: "b", activate() { calls.push("activate-b"); }, async dispose() { calls.push("dispose-b"); } },
    ]);

    await registry.dispose();
    await registry.dispose();

    expect(calls).toEqual(["activate-a", "activate-b", "dispose-b", "dispose-a"]);
  });

  it("continues disposing after one plugin fails", async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry();
    await registry.load([
      { name: "a", activate() {}, async dispose() { calls.push("a"); } },
      { name: "b", activate() {}, async dispose() { calls.push("b"); throw new Error("b failed"); } },
    ]);

    await expect(registry.dispose()).rejects.toThrow("b failed");
    expect(calls).toEqual(["b", "a"]);
  });

  it("concurrent dispose calls share one in-flight disposal", async () => {
    const order: string[] = [];
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const registry = new PluginRegistry();
    await registry.load([
      { name: "a", activate() {}, async dispose() { order.push("dispose-a"); } },
      { name: "b", activate() {}, async dispose() { order.push("dispose-b"); await gateB; } },
    ]);

    const first = registry.dispose(); // starts the reverse pass: b first, parked on its gate
    const second = registry.dispose(); // must JOIN the in-flight pass, not pop a concurrently
    order.push("second-joined");
    expect(order).toEqual(["dispose-b", "second-joined"]);
    releaseB();
    await Promise.all([first, second]);
    expect(order).toEqual(["dispose-b", "second-joined", "dispose-a"]);
  });

  it("concurrent dispose calls surface the same failure", async () => {
    let disposeCalls = 0;
    const registry = new PluginRegistry();
    await registry.load([
      {
        name: "boom",
        activate() {},
        async dispose() {
          disposeCalls += 1;
          throw new Error("boom failed");
        },
      },
    ]);

    const results = await Promise.allSettled([registry.dispose(), registry.dispose()]);
    expect(disposeCalls).toBe(1);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") {
        expect((r.reason as Error).message).toContain("boom failed");
      }
    }
  });

  it("rolls back already activated plugins when activation fails", async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry();
    const plugins: HarnessPlugin[] = [
      { name: "a", activate() {}, async dispose() { calls.push("dispose-a"); } },
      { name: "b", activate() { throw new Error("activate-b failed"); } },
      { name: "c", activate() { calls.push("activate-c"); } },
    ];

    await expect(registry.load(plugins)).rejects.toThrow("activate-b failed");
    await registry.dispose();

    expect(calls).toEqual(["dispose-a"]);
  });
});
