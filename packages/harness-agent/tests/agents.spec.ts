import { Context } from "@innocencecode/kernel";
import { AgentsPlugin, type AgentDef, type AgentsService } from "@innocencecode/harness-agent";
import { describe, expect, expectTypeOf, it } from "vitest";

// Mirrors harness-tools' test setup: load the plugin into a fresh kernel
// context; `ctx.agents` is live while the plugin fiber is active.
async function withAgents(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(AgentsPlugin);
  return ctx;
}

function agent(id: string, overrides: Partial<AgentDef> = {}): AgentDef {
  return { id, title: `${id} 代理`, ...overrides };
}

describe("agents registration", () => {
  it("registers and looks up agents by id", async () => {
    const ctx = await withAgents();
    ctx.agents.register(agent("default", { description: "通用代理" }));
    ctx.agents.register(agent("plan"));
    expect(ctx.agents.byId("default")).toMatchObject({
      id: "default",
      title: "default 代理",
      description: "通用代理",
    });
    expect(ctx.agents.byId("plan")).toEqual({ id: "plan", title: "plan 代理" });
    expect(ctx.agents.byId("missing")).toBeUndefined();
  });

  it("keeps registration order in all()", async () => {
    const ctx = await withAgents();
    ctx.agents.register(agent("default"));
    ctx.agents.register(agent("plan"));
    ctx.agents.register(agent("full"));
    expect(ctx.agents.all().map((a) => a.id)).toEqual(["default", "plan", "full"]);
  });

  it("exposes a readonly view (type-level gate)", async () => {
    const ctx = await withAgents();
    expectTypeOf(ctx.agents.all()).toEqualTypeOf<readonly AgentDef[]>();
  });

  it("rejects duplicate ids", async () => {
    const ctx = await withAgents();
    ctx.agents.register(agent("default"));
    expect(() => ctx.agents.register(agent("default", { title: "再次注册" }))).toThrow(
      "duplicate agent registration: default",
    );
  });
});

describe("agents service lifecycle on the kernel", () => {
  it("carries the spine plugin name \"harness-agent\"", () => {
    expect(AgentsPlugin.name).toBe("harness-agent");
  });

  it("publishes the service under \"agents\" while its fiber is active", async () => {
    const ctx = await withAgents();
    expect((ctx as { agents?: AgentsService }).agents).toBeDefined();
    ctx.agents.register(agent("default"));
    expect(ctx.agents.all().map((a) => a.id)).toEqual(["default"]);
  });

  it("withdraws the service when the plugin fiber is disposed", async () => {
    const ctx = new Context();
    const fiber = await ctx.plugin(AgentsPlugin);
    const service = ctx.agents;
    expect((ctx as { agents?: AgentsService }).agents).toBeDefined();
    await fiber.dispose();
    // The withdraw handle returned by `apply` removed the context property;
    // the detached service object stays usable.
    expect((ctx as { agents?: AgentsService }).agents).toBeUndefined();
    expect(() => service.register(agent("late"))).not.toThrow();
  });
});
