import { describe, expect, it } from "vitest";
import { runLoop } from "../src/loop";
import { PermissionEngine } from "../src/permission";
import { PluginRegistry } from "../src/registry";
import type { Delta, Provider, Tool, ToolResult } from "../src";
import type { HarnessEvent } from "../src/events";

interface Turn {
  text?: string;
  toolCalls?: Array<{ toolName: string; args?: Record<string, unknown> }>;
}

function scriptedProvider(turns: Turn[], log?: (i: number) => void): Provider {
  let i = 0;
  return {
    id: "scripted",
    async *chat(): AsyncIterable<Delta> {
      log?.(i);
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

function fakeTool(
  name: string,
  behavior: (args: Record<string, unknown>) => Promise<ToolResult>,
  readOnly = false,
): Tool & { calls: Array<Record<string, unknown>> } {
  const t = {
    name,
    description: name,
    readOnly,
    parameters: { type: "object" },
    calls: [] as Array<Record<string, unknown>>,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      t.calls.push(args);
      return behavior(args);
    },
  } as Tool & { calls: Array<Record<string, unknown>> };
  return t;
}

const allowAll = () =>
  new PermissionEngine({ mode: "auto", decider: { ask: async () => "deny" } });

function setup(tools: Tool[], provider: Provider, permission = allowAll()) {
  const registry = new PluginRegistry();
  for (const tool of tools) registry.tools.set(tool.name, tool);
  const events: HarnessEvent[] = [];
  const history: Parameters<typeof runLoop>[0] = [];
  return {
    registry,
    events,
    history,
    run: (text: string, extra: { maxTurns?: number } = {}) =>
      runLoop(history, text, {
        provider,
        registry,
        permission,
        systemPrompt: "test",
        workspaceRoot: "/tmp/ws",
        onEvent: (e) => events.push(e),
        ...extra,
      }),
  };
}

describe("runLoop", () => {
  it("runs tool calls then finishes with the final text", async () => {
    const echo = fakeTool("Echo", async (args) => ({
      content: `echo:${String(args.msg ?? "")}`,
    }));
    const provider = scriptedProvider([
      { toolCalls: [{ toolName: "Echo", args: { msg: "hi" } }] },
      { text: "all done" },
    ]);
    const { events, history, run } = setup([echo], provider);

    const result = await run("please echo");
    expect(result.turns).toBe(2);
    expect(result.finalText).toBe("all done");
    expect(echo.calls).toEqual([{ msg: "hi" }]);

    // History: user, assistant(toolCall), user(toolResult), assistant(final)
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const toolResult = history[2].parts[0];
    expect(toolResult).toMatchObject({
      type: "toolResult",
      content: "echo:hi",
      isError: undefined,
    });

    const types = events.map((e) => e.type);
    expect(types).toContain("turnStart");
    expect(types).toContain("token");
    expect(types.filter((t) => t === "toolCall")).toHaveLength(1);
    expect(types.filter((t) => t === "toolResult")).toHaveLength(1);
    expect(types[types.length - 1]).toBe("done");
  });

  it("unknown tools produce an error result, not a crash", async () => {
    const provider = scriptedProvider([
      { toolCalls: [{ toolName: "Ghost" }] },
      { text: "recovered" },
    ]);
    const { history, run } = setup([], provider);
    const result = await run("x");
    expect(result.finalText).toBe("recovered");
    const tr = history[2].parts[0] as { isError?: boolean; content: string };
    expect(tr.isError).toBe(true);
    expect(tr.content).toContain("未知工具");
  });

  it("thrown tool errors feed back to the model as error results", async () => {
    const bomb = fakeTool("Bomb", async () => {
      throw new Error("boom");
    });
    const provider = scriptedProvider([
      { toolCalls: [{ toolName: "Bomb" }] },
      { text: "handled" },
    ]);
    const { events, history, run } = setup([bomb], provider);
    const result = await run("x");
    expect(result.finalText).toBe("handled");
    const tr = history[2].parts[0] as { isError?: boolean; content: string };
    expect(tr.isError).toBe(true);
    expect(tr.content).toContain("boom");
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });

  it("permission deny turns into an error tool result", async () => {
    const write = fakeTool("Write", async () => ({ content: "written" }));
    const provider = scriptedProvider([
      { toolCalls: [{ toolName: "Write", args: { path: "a.ts" } }] },
      { text: "okay, I will not" },
    ]);
    const permission = new PermissionEngine({
      mode: "plan",
      decider: { ask: async () => "allow" },
    });
    const { history, run, events } = setup([write], provider, permission);
    const result = await run("write it");
    expect(result.finalText).toBe("okay, I will not");
    expect(write.calls).toHaveLength(0);
    const tr = history[2].parts[0] as { isError?: boolean; content: string };
    expect(tr.isError).toBe(true);
    expect(tr.content).toContain("权限被拒绝");
    const permEvent = events.find((e) => e.type === "permission");
    expect(permEvent && permEvent.type === "permission" && permEvent.resolution.via).toBe(
      "planMode",
    );
  });

  it("stops after maxTurns even if the model keeps calling tools", async () => {
    const loop = fakeTool("Loop", async () => ({ content: "again" }));
    const provider = scriptedProvider([{ toolCalls: [{ toolName: "Loop" }] }]);
    const { run } = setup([loop], provider);
    const result = await run("go", { maxTurns: 3 });
    expect(result.turns).toBe(3);
    expect(loop.calls).toHaveLength(3);
  });

  it("multiple tool calls in one turn each get a result", async () => {
    const a = fakeTool("A", async () => ({ content: "a" }));
    const b = fakeTool("B", async () => ({ content: "b" }));
    const provider = scriptedProvider([
      { toolCalls: [{ toolName: "A" }, { toolName: "B" }] },
      { text: "done" },
    ]);
    const { history, run } = setup([a, b], provider);
    await run("x");
    const results = history[2].parts;
    expect(results).toHaveLength(2);
    expect(results.map((p) => (p as { content: string }).content)).toEqual(["a", "b"]);
  });
});
