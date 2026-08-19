import { describe, expect, it } from "vitest";
import {
  PluginRegistry,
  type HarnessPlugin,
  type Tool,
  type ToolExecutionMiddleware,
} from "../src";

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
