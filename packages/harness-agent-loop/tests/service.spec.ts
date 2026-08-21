import {
  createAgentLoopPlugin,
  createRunLoop,
  type LoopDeps,
  type RunLoopFunction,
} from "@innocencecode/harness-agent-loop";
import { Context } from "@innocencecode/kernel";
import { PermissionEngine } from "@innocencecode/harness-permissions";
import type { Delta, Provider } from "@innocencecode/harness-providers";
import { textMessage } from "@innocencecode/harness-session";
import { ToolsPlugin, type Tool } from "@innocencecode/harness-tools";
import { describe, expect, it } from "vitest";

function fakeTool(
  name: string,
  behavior: (args: Record<string, unknown>) => Promise<{ content: string }>,
): Tool & { calls: number } {
  const t = {
    name,
    description: name,
    readOnly: false,
    sideEffect: "unknown" as const,
    parameters: { type: "object" },
    calls: 0,
    permissionResource: () => ({ action: "write" as const, kind: "test", scope: name }),
    persistArgs: (args: Record<string, unknown>) => ({ ...args }),
    async execute(args: Record<string, unknown>) {
      t.calls += 1;
      return behavior(args);
    },
  } as unknown as Tool & { calls: number };
  return t;
}

/** Provider whose every turn requests the same tool (maxTurns probe). */
function loopingProvider(): Provider {
  let i = 0;
  return {
    id: "looping",
    async *chat(): AsyncIterable<Delta> {
      i += 1;
      yield { type: "toolCall", id: `call_${i}`, toolName: "Loop", args: {} };
    },
  };
}

interface Turn {
  text?: string;
  toolCalls?: Array<{ toolName: string; args?: Record<string, unknown> }>;
}

function scriptedProvider(turns: Turn[]): Provider {
  let i = 0;
  return {
    id: "scripted",
    async *chat(): AsyncIterable<Delta> {
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      if (turn.text) yield { type: "text", text: turn.text };
      for (const [n, call] of (turn.toolCalls ?? []).entries()) {
        yield {
          type: "toolCall",
          id: `call_${i}_${n}`,
          toolName: call.toolName,
          args: call.args ?? {},
        };
      }
    },
  };
}

const allowAll = () =>
  new PermissionEngine({ mode: "auto", decider: { ask: async () => "deny" as const } });

/** Loads a tools service with one call-counting Loop tool and binds loop deps. */
async function makeDeps(overrides: Partial<LoopDeps> = {}): Promise<{ deps: LoopDeps; tool: Tool & { calls: number } }> {
  const kernel = new Context();
  await kernel.plugin(ToolsPlugin);
  const tool = fakeTool("Loop", async () => ({ content: "again" }));
  kernel.tools.register(tool);
  return {
    tool,
    deps: {
      tools: kernel.tools,
      permission: allowAll(),
      provider: loopingProvider(),
      history: [],
      systemPrompt: "test",
      workspaceRoot: "/tmp/ws",
      onEvent: () => {},
      ...overrides,
    },
  };
}

describe("loop service lifecycle on the kernel", () => {
  it("carries the spine plugin name \"harness-agent-loop\"", async () => {
    const plugin = createAgentLoopPlugin((await makeDeps()).deps);
    expect(plugin.name).toBe("harness-agent-loop");
  });

  it("publishes the run function under \"loop\" while its fiber is active", async () => {
    const ctx = new Context();
    await ctx.plugin(createAgentLoopPlugin((await makeDeps()).deps));
    expect(typeof ctx.loop).toBe("function");
  });

  it("withdraws the run function when the plugin fiber is disposed", async () => {
    const ctx = new Context();
    const fiber = await ctx.plugin(createAgentLoopPlugin((await makeDeps()).deps));
    const run = ctx.loop;
    expect((ctx as { loop?: RunLoopFunction }).loop).toBeDefined();
    await fiber.dispose();
    expect((ctx as { loop?: RunLoopFunction }).loop).toBeUndefined();
    // The detached run function stays callable (the loop is pure over deps).
    expect(typeof run).toBe("function");
  });
});

describe("createRunLoop binding", () => {
  it("lets per-run options override the session-level defaults", async () => {
    const { deps, tool } = await makeDeps({ maxTurns: 5 });
    const run = createRunLoop(deps);
    const result = await run(textMessage("user", "go"), { maxTurns: 2 });
    expect(result.turns).toBe(2);
    expect(tool.calls).toBe(2);
  });

  it("falls back to the deps default when the run passes no override", async () => {
    const { deps, tool } = await makeDeps({ maxTurns: 3 });
    const run = createRunLoop(deps);
    const result = await run(textMessage("user", "go"));
    expect(result.turns).toBe(3);
    expect(tool.calls).toBe(3);
  });

  it("resolves a function systemPrompt once per run", async () => {
    const systems: string[] = [];
    const provider: Provider = {
      id: "echo",
      async *chat(req): AsyncIterable<Delta> {
        systems.push(req.system);
        yield { type: "text", text: "ok" };
      },
    };
    let base = "first";
    const { deps } = await makeDeps({ provider, systemPrompt: () => base });
    const run = createRunLoop(deps);

    await run(textMessage("user", "q1"));
    base = "second";
    await run(textMessage("user", "q2"));

    expect(systems).toEqual(["first", "second"]);
  });

  it("shares one history ledger across runs of the same bound loop", async () => {
    const provider = scriptedProvider([{ text: "done" }]);
    const { deps } = await makeDeps({ provider });
    const run = createRunLoop(deps);
    await run(textMessage("user", "q1"));
    await run(textMessage("user", "q2"));
    expect(deps.history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});
