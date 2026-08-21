import { describe, expect, it } from "vitest";
import { createRunLoop } from "../src";
import { PermissionEngine } from "@innocencecode/harness-permissions";
import { Context } from "@innocencecode/kernel";
import { ToolsPlugin } from "@innocencecode/harness-tools";
import { textMessage, type Message } from "@innocencecode/harness-session";
import type { Delta, Provider } from "@innocencecode/harness-providers";
import type { Tool, ToolResult } from "@innocencecode/harness-tools";
import type { HarnessEvent } from "@innocencecode/harness-session";

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
    sideEffect: readOnly ? ("none" as const) : ("unknown" as const),
    parameters: { type: "object" },
    calls: [] as Array<Record<string, unknown>>,
    permissionResource: () => ({
      action: readOnly ? "read" : "write",
      kind: "test",
      scope: name,
    }),
    persistArgs: (args: Record<string, unknown>) => ({ ...args }),
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      t.calls.push(args);
      return behavior(args);
    },
  } as Tool & { calls: Array<Record<string, unknown>> };
  return t;
}

const allowAll = () =>
  new PermissionEngine({ mode: "auto", decider: { ask: async () => "deny" } });

async function setup(tools: Tool[], provider: Provider, permission = allowAll()) {
  const kernel = new Context();
  await kernel.plugin(ToolsPlugin);
  for (const tool of tools) kernel.tools.register(tool);
  const events: HarnessEvent[] = [];
  const history: Message[] = [];
  const loop = createRunLoop({
    tools: kernel.tools,
    provider,
    permission,
    history,
    systemPrompt: "test",
    workspaceRoot: "/tmp/ws",
    onEvent: (e) => events.push(e),
  });
  return {
    toolsService: kernel.tools,
    events,
    history,
    run: (
      text: string,
      extra: {
        maxTurns?: number;
        signal?: AbortSignal;
        toolTimeoutMs?: number;
        abortGraceMs?: number;
      } = {},
    ) => loop(textMessage("user", text), extra),
  };
}

/** Tool whose body rejects with the derived signal's abort reason. */
function abortAwareTool(name: string): Tool & { calls: number } {
  const t = {
    name,
    description: name,
    readOnly: false,
    sideEffect: "unknown" as const,
    parameters: { type: "object" },
    calls: 0,
    permissionResource: () => ({ action: "write", kind: "test", scope: name }),
    persistArgs: (args: Record<string, unknown>) => ({ ...args }),
    execute(_args: Record<string, unknown>, ctx: { signal: AbortSignal }) {
      t.calls += 1;
      return new Promise<ToolResult>((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
      });
    },
  } as unknown as Tool & { calls: number };
  return t;
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
    const { events, history, run } = await setup([echo], provider);

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
    const { history, run } = await setup([], provider);
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
    const { events, history, run } = await setup([bomb], provider);
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
    const { history, run, events } = await setup([write], provider, permission);
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
    const { run } = await setup([loop], provider);
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
    const { history, run } = await setup([a, b], provider);
    await run("x");
    const results = history[2].parts;
    expect(results).toHaveLength(2);
    expect(results.map((p) => (p as { content: string }).content)).toEqual(["a", "b"]);
  });

  it("permission deny never reaches tool middleware", async () => {
    const write = fakeTool("Write", async () => ({ content: "written" }));
    const provider = scriptedProvider([
      { toolCalls: [{ toolName: "Write", args: { path: "a.ts" } }] },
      { text: "denied" },
    ]);
    const permission = new PermissionEngine({
      mode: "plan",
      decider: { ask: async () => "allow" },
    });
    const { toolsService, run } = await setup([write], provider, permission);
    const seen: string[] = [];
    toolsService.registerMiddleware({
      name: "spy",
      async execute(invocation, next) {
        seen.push(invocation.toolName);
        return next();
      },
    });

    const result = await run("write it");
    expect(result.finalText).toBe("denied");
    expect(write.calls).toHaveLength(0);
    expect(seen).toEqual([]);
  });

  it("wraps allowed tools with middleware and stamps invocation/resource/outcome on events", async () => {
    const echo: Tool = {
      name: "Echo",
      description: "Echo",
      readOnly: false,
      sideEffect: "unknown",
      parameters: { type: "object" },
      permissionResource: () => ({ action: "write", kind: "test", scope: "Echo" }),
      // Persisted args differ from raw ones — middleware must only see these.
      persistArgs: (args) => ({ msg: `persisted:${String(args.msg ?? "")}` }),
      execute: async (args) => ({ content: `echo:${String(args.msg ?? "")}` }),
    };
    const provider = scriptedProvider([
      { toolCalls: [{ toolName: "Echo", args: { msg: "hi" } }] },
      { text: "done" },
    ]);
    const { toolsService, events, run } = await setup([echo], provider);
    const seen: Array<{ toolName: string; persistedArgs: Record<string, unknown> }> = [];
    toolsService.registerMiddleware({
      name: "spy",
      async execute(invocation, next) {
        seen.push({ toolName: invocation.toolName, persistedArgs: invocation.persistedArgs });
        return next();
      },
    });

    await run("x");
    expect(seen).toEqual([{ toolName: "Echo", persistedArgs: { msg: "persisted:hi" } }]);

    const callEvent = events.find((e) => e.type === "toolCall");
    if (!callEvent || callEvent.type !== "toolCall") throw new Error("missing toolCall event");
    expect(callEvent.invocationId).toMatch(/^inv-/);
    const resultEvent = events.find((e) => e.type === "toolResult");
    if (!resultEvent || resultEvent.type !== "toolResult") throw new Error("missing toolResult event");
    expect(resultEvent).toMatchObject({
      outcome: "success",
      resource: { action: "write", kind: "test", scope: "Echo" },
      invocationId: callEvent.invocationId,
      isError: undefined,
    });
  });

  it("aborts runaway tools at the timeout and reports a timeout outcome", async () => {
    const hang = abortAwareTool("Hang");
    const provider = scriptedProvider([
      { toolCalls: [{ toolName: "Hang" }] },
      { text: "recovered" },
    ]);
    const { events, history, run } = await setup([hang], provider);

    const result = await run("x", { toolTimeoutMs: 20, abortGraceMs: 20 });
    expect(result.finalText).toBe("recovered");
    const tr = history[2].parts[0] as { isError?: boolean; content: string };
    expect(tr.isError).toBe(true);
    expect(tr.content).toContain("超时");
    const resultEvent = events.find((e) => e.type === "toolResult");
    expect(resultEvent && resultEvent.type === "toolResult" && resultEvent.outcome).toBe("timeout");
  });

  it("reports tools that ignore the abort as unstable", async () => {
    const zombie: Tool = {
      name: "Zombie",
      description: "Zombie",
      readOnly: false,
      sideEffect: "unknown",
      parameters: { type: "object" },
      permissionResource: () => ({ action: "write", kind: "test", scope: "Zombie" }),
      persistArgs: (args) => ({ ...args }),
      // Ignores the abort signal entirely: never settles.
      execute: () => new Promise<ToolResult>(() => {}),
    };
    const provider = scriptedProvider([
      { toolCalls: [{ toolName: "Zombie" }] },
      { text: "recovered" },
    ]);
    const { events, history, run } = await setup([zombie], provider);

    const result = await run("x", { toolTimeoutMs: 20, abortGraceMs: 20 });
    expect(result.finalText).toBe("recovered");
    const tr = history[2].parts[0] as { isError?: boolean; content: string };
    expect(tr.isError).toBe(true);
    expect(tr.content).toContain("TOOL_UNSTABLE");
    const resultEvent = events.find((e) => e.type === "toolResult");
    expect(resultEvent && resultEvent.type === "toolResult" && resultEvent.outcome).toBe("unstable");
  });

  it("reports an aborted outcome when the run is stopped mid-tool", async () => {
    const stop = new AbortController();
    const tool: Tool = {
      name: "Stop",
      description: "Stop",
      readOnly: false,
      sideEffect: "unknown",
      parameters: { type: "object" },
      permissionResource: () => ({ action: "write", kind: "test", scope: "Stop" }),
      persistArgs: (args) => ({ ...args }),
      execute: (_args, ctx) =>
        new Promise<ToolResult>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
          queueMicrotask(() => stop.abort());
        }),
    };
    const provider = scriptedProvider([
      { toolCalls: [{ toolName: "Stop" }] },
      { text: "never reached" },
    ]);
    const { events, history, run } = await setup([tool], provider);

    const result = await run("x", { signal: stop.signal });
    // Loop breaks on the next turn-top check; the aborted result is in history.
    const tr = history[2].parts[0] as { isError?: boolean; content: string };
    expect(tr.isError).toBe(true);
    expect(tr.content).toContain("中止");
    const resultEvent = events.find((e) => e.type === "toolResult");
    expect(resultEvent && resultEvent.type === "toolResult" && resultEvent.outcome).toBe("aborted");
    expect(result.finalText).toBe("");
    // M1: a mid-tool stop must surface in the loop result, not just in history.
    expect(result.aborted).toBe(true);
  });

  it("arms the grace window on parent stop so an abort-ignoring tool goes unstable without waiting out the timeout", async () => {
    const stop = new AbortController();
    const zombie: Tool = {
      name: "ZombieStop",
      description: "ZombieStop",
      readOnly: false,
      sideEffect: "unknown",
      parameters: { type: "object" },
      permissionResource: () => ({ action: "write", kind: "test", scope: "ZombieStop" }),
      persistArgs: (args) => ({ ...args }),
      // Stops the run shortly after start, then ignores every abort forever.
      execute: () => {
        setTimeout(() => stop.abort(), 5);
        return new Promise<ToolResult>(() => {});
      },
    };
    const provider = scriptedProvider([
      { toolCalls: [{ toolName: "ZombieStop" }] },
      { text: "recovered" },
    ]);
    const { events, history, run } = await setup([zombie], provider);

    // 60s timeout with a 25ms grace: without grace-on-parent-abort the loop
    // would block on the deadline and this test itself would time out.
    const result = await run("x", { signal: stop.signal, toolTimeoutMs: 60_000, abortGraceMs: 25 });
    expect(result.aborted).toBe(true);
    const tr = history[2].parts[0] as { isError?: boolean; content: string };
    expect(tr.isError).toBe(true);
    expect(tr.content).toContain("TOOL_UNSTABLE");
    const resultEvent = events.find((e) => e.type === "toolResult");
    expect(resultEvent && resultEvent.type === "toolResult" && resultEvent.outcome).toBe("unstable");
  });

  it("classifies non-abort-shaped failures during a parent stop as aborted, not error", async () => {
    const stop = new AbortController();
    const tool: Tool = {
      name: "OddStop",
      description: "OddStop",
      readOnly: false,
      sideEffect: "unknown",
      parameters: { type: "object" },
      permissionResource: () => ({ action: "write", kind: "test", scope: "OddStop" }),
      persistArgs: (args) => ({ ...args }),
      // Cancels with a PLAIN error when the run stops: the outcome must still
      // be "aborted" because the parent signal is what ended the invocation.
      execute: (_args, ctx) =>
        new Promise<ToolResult>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("worker cancelled")), {
            once: true,
          });
          queueMicrotask(() => stop.abort());
        }),
    };
    const provider = scriptedProvider([
      { toolCalls: [{ toolName: "OddStop" }] },
      { text: "after" },
    ]);
    const { events, history, run } = await setup([tool], provider);

    const result = await run("x", { signal: stop.signal });
    expect(result.aborted).toBe(true);
    const resultEvent = events.find((e) => e.type === "toolResult");
    expect(resultEvent && resultEvent.type === "toolResult" && resultEvent.outcome).toBe("aborted");
    const tr = history[2].parts[0] as { isError?: boolean; content: string };
    expect(tr.content).toContain("工具执行已中止");
    expect(tr.content).toContain("worker cancelled");
  });

  it("fail-closes remaining calls after a stop instead of consulting the permission chain", async () => {
    const stop = new AbortController();
    let asks = 0;
    const permission = new PermissionEngine({
      mode: "ask",
      decider: {
        ask: async () => {
          asks += 1;
          return "allow";
        },
      },
    });
    const slow: Tool = {
      name: "SlowStop",
      description: "SlowStop",
      readOnly: false,
      sideEffect: "unknown",
      parameters: { type: "object" },
      permissionResource: () => ({ action: "write", kind: "test", scope: "SlowStop" }),
      persistArgs: (args) => ({ ...args }),
      execute: (_args, ctx) =>
        new Promise<ToolResult>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
          queueMicrotask(() => stop.abort());
        }),
    };
    const follow = fakeTool("FollowUp", async () => ({ content: "followed" }));
    const provider = scriptedProvider([
      { toolCalls: [{ toolName: "SlowStop" }, { toolName: "FollowUp" }] },
      { text: "after" },
    ]);
    const { events, history, run } = await setup([slow, follow], provider, permission);

    const result = await run("x", { signal: stop.signal });
    // Only the in-flight call consulted permissions; the post-stop call was
    // fail-closed without prompting the user again.
    expect(asks).toBe(1);
    expect(follow.calls).toHaveLength(0);
    const results = history[2].parts as Array<{ content: string; isError?: boolean }>;
    expect(results[1]!.isError).toBe(true);
    expect(results[1]!.content).toContain("运行已中止");
    // R1: a user-stop termination is "aborted" on the machine-readable channel,
    // so outcome-aggregating hosts never count Stop presses as tool errors.
    const resultEvents = events.filter((e) => e.type === "toolResult");
    expect(
      resultEvents[1] && resultEvents[1].type === "toolResult" && resultEvents[1].outcome,
    ).toBe("aborted");
    expect(result.aborted).toBe(true);
  });
});
