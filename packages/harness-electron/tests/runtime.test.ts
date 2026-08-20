import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSession } from "@innocencecode/harness-core";
import { createMockProvider, type MockTurn } from "@innocencecode/provider-mock";
import { fsPlugin } from "@innocencecode/tools-fs";
import { shellPlugin } from "@innocencecode/tools-shell";
import {
  DEFAULT_SETTINGS,
  HarnessRuntime,
  IN_FLIGHT_BUILD_DISPOSE_TIMEOUT_MS,
  decodeTranscript,
  systemPromptFor,
  type AskResponse,
  type HarnessSettings,
  type LiveToolPart,
  type PluginFactoryContext,
  type RuntimeHooks,
  type RuntimeOptions,
} from "../src";

/** Plain (non-task, main-route) turn through the request-object send API. */
function chatTurn(
  runtime: HarnessRuntime,
  sessionId: string,
  text: string,
  messageId: string,
): Promise<void> {
  return runtime.send({ sessionId, taskId: "", routeId: "main", text, messageId });
}

/** agentFactory seam wrapper: records each built AgentSession by cache key. */
function recordingAgentFactory() {
  const sessions = new Map<string, AgentSession>();
  const factory: NonNullable<RuntimeOptions["agentFactory"]> = async (context, create) => {
    const session = await create();
    sessions.set(`${context.sessionId}:${context.routeId}`, session);
    return session;
  };
  return { sessions, factory };
}

let persistDir: string;
let workspace: string;

interface Recorded {
  deltas: string[];
  tools: LiveToolPart[];
  completed: number;
  errors: string[];
  asks: Array<{ toolName: string; answer: AskResponse }>;
}

const emptyRecorded = (): Recorded => ({ deltas: [], tools: [], completed: 0, errors: [], asks: [] });

function makeHooks(recorded: Recorded, answer: AskResponse = "allow"): RuntimeHooks {
  return {
    onDelta: (_s, _m, delta) => recorded.deltas.push(delta),
    onTool: (_s, _m, part) => recorded.tools.push(part),
    onThinking: () => {},
    onCompleted: () => {
      recorded.completed += 1;
    },
    onError: (_s, _m, error) => recorded.errors.push(error),
    askPermission: async (_s, _m, ask) => {
      recorded.asks.push({ toolName: ask.call.toolName, answer });
      return answer;
    },
    log: () => {},
  };
}

/** Default options with the test-side composition root (fs + shell tools). */
function runtimeOptions(
  turns: MockTurn[],
  settings: Partial<HarnessSettings> = {},
  recorded: Recorded = emptyRecorded(),
  answer: AskResponse = "allow",
): RuntimeOptions {
  const full: HarnessSettings = { ...DEFAULT_SETTINGS, ...settings };
  return {
    settings: () => full,
    hooks: makeHooks(recorded, answer),
    persistDir,
    providerFactory: () => createMockProvider({ turns }),
    pluginsForSession: () => [fsPlugin, shellPlugin],
  };
}

function makeRuntime(
  turns: MockTurn[],
  settings: Partial<HarnessSettings> = {},
  recorded: Recorded,
  answer: AskResponse = "allow",
) {
  return new HarnessRuntime(runtimeOptions(turns, settings, recorded, answer));
}

beforeAll(async () => {
  persistDir = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-rt-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-ws-"));
  await fs.writeFile(path.join(workspace, "hello.txt"), "hello harness\n", "utf8");
});

afterAll(async () => {
  await fs.rm(persistDir, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("HarnessRuntime", () => {
  it("streams a plain-text turn end-to-end and persists one append-only turn-v2 record", async () => {
    const recorded: Recorded = emptyRecorded();
    const runtime = makeRuntime([{ text: "你好，我是回复" }], { workspaceRoot: workspace }, recorded);

    await chatTurn(runtime, "sess-1", "打个招呼", "msg_t1");

    expect(recorded.deltas.join("")).toContain("你好，我是回复");
    expect(recorded.completed).toBe(1);
    expect(recorded.errors).toEqual([]);

    const file = path.join(persistDir, "sess-1.jsonl");
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.type).toBe("turn-v2");
    expect(record.turnId).toBe("msg_t1");
    expect(record.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(record.messages.at(-1).parts[0].text).toContain("你好，我是回复");
  });

  it("关闭应用后继续旧会话：runtime 从 transcript 回灌，新增 turn-v2 不重复旧历史", async () => {
    const full: HarnessSettings = { ...DEFAULT_SETTINGS, workspaceRoot: workspace };
    const first = new HarnessRuntime({
      ...runtimeOptions([{ text: "第一答" }], full),
    });
    await chatTurn(first, "sess-restart", "第一问", "turn-1");

    // New runtime instance = fully closed/reopened app.
    const seenRequests: string[][] = [];
    const second = new HarnessRuntime({
      ...runtimeOptions([], full),
      providerFactory: () =>
        createMockProvider({
          turns: [{ text: "第二答" }],
          onChat: (req) =>
            seenRequests.push(req.messages.map((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text).join(""))),
        }),
    });
    await chatTurn(second, "sess-restart", "第二问", "turn-2");

    expect(seenRequests[0]).toEqual(["第一问", "第一答", "第二问"]); // 模型拿到完整上下文且本轮仅一次
    const raw = await fs.readFile(path.join(persistDir, "sess-restart.jsonl"), "utf8");
    const records = raw.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((r) => r.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(records.map((r) => r.messages.length)).toEqual([2, 2]); // 每行只存本轮，不存全量快照
    const decoded = decodeTranscript(raw).history;
    expect(decoded.map((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text).join(""))).toEqual([
      "第一问", "第一答", "第二问", "第二答",
    ]);
  });

  it("runs fs tools against the workspace with a permission ask", async () => {
    const recorded: Recorded = emptyRecorded();
    const runtime = makeRuntime(
      [
        { toolCalls: [{ toolName: "Read", args: { path: "hello.txt" } }] },
        { text: "读完了" },
      ],
      { workspaceRoot: workspace, permissionMode: "ask" },
      recorded,
      "allow",
    );

    await chatTurn(runtime, "sess-2", "读 hello.txt", "msg_t2");

    expect(recorded.asks).toEqual([{ toolName: "Read", answer: "allow" }]);
    const joined = recorded.deltas.join("");
    expect(joined).toContain("读完了");
    // Tool activity arrives on the structured channel, not as markdown text.
    expect(
      recorded.tools.some((p) => p.type === "toolCall" && p.toolName === "Read"),
    ).toBe(true);
    expect(
      recorded.tools.some(
        (p) => p.type === "toolResult" && p.content.includes("hello harness"),
      ),
    ).toBe(true);
    expect(recorded.completed).toBe(1);
  });

  it("feeds a denied permission back as an error result the model can see", async () => {
    const recorded: Recorded = emptyRecorded();
    const runtime = makeRuntime(
      [
        { toolCalls: [{ toolName: "Write", args: { path: "x.txt", content: "nope" } }] },
        { text: "好吧，我不写了" },
      ],
      { workspaceRoot: workspace, permissionMode: "ask" },
      recorded,
      "deny",
    );

    await chatTurn(runtime, "sess-3", "写 x.txt", "msg_t3");

    expect(recorded.asks).toHaveLength(1);
    const joined = recorded.deltas.join("");
    expect(joined).toContain("好吧，我不写了");
    expect(
      recorded.tools.some((p) => p.type === "toolResult" && p.isError === true),
    ).toBe(true);
    await expect(fs.access(path.join(workspace, "x.txt"))).rejects.toThrow();
  });

  it("allow/deny/full 三种决策路径都恰好落一次 audit（log hook 记 permission）", async () => {
    // full 不询问但照常审计；ask 的 allow/deny 各审计一次——漏审计 =
    // 权限账本缺账，多审计 = 同一请求重复入账。
    const cases: Array<{ mode: HarnessSettings["permissionMode"]; answer: AskResponse }> = [
      { mode: "ask", answer: "allow" },
      { mode: "ask", answer: "deny" },
      { mode: "full", answer: "deny" },
    ];
    for (const { mode, answer } of cases) {
      const permissionAudits: unknown[] = [];
      const recorded: Recorded = emptyRecorded();
      const runtime = new HarnessRuntime({
        ...runtimeOptions(
          [{ toolCalls: [{ toolName: "Read", args: { path: "hello.txt" } }] }, { text: "完成" }],
          { workspaceRoot: workspace, permissionMode: mode },
          recorded,
          answer,
        ),
        hooks: {
          ...makeHooks(recorded, answer),
          log: (_level, msg, data) => {
            if (msg === "permission") permissionAudits.push(data);
          },
        },
      });

      await chatTurn(runtime, `audit-${mode}-${answer}`, "读一下", `m-audit-${mode}-${answer}`);
      await runtime.dispose(`audit-${mode}-${answer}`);

      expect(permissionAudits, `${mode}/${answer} 应恰好一次 audit`).toHaveLength(1);
    }
  });

  it("rebuilds the cached agent session when settings change, keeping history", async () => {
    const recorded: Recorded = emptyRecorded();
    const settings: HarnessSettings = { ...DEFAULT_SETTINGS, workspaceRoot: workspace };
    let currentTurns: MockTurn[] = [{ text: "来自设置A的回复" }];
    const runtime = new HarnessRuntime({
      ...runtimeOptions([], {}, recorded),
      settings: () => settings,
      providerFactory: () => createMockProvider({ turns: currentTurns }),
    });

    await chatTurn(runtime, "sess-4", "一", "msg_t4a");
    // Same runtime, new settings hash -> cached session rebuilt with the
    // previous conversation carried over, new provider takes effect.
    currentTurns = [{ text: "来自设置B的回复" }];
    settings.permissionMode = "plan";
    await chatTurn(runtime, "sess-4", "二", "msg_t4b");

    const joined = recorded.deltas.join("");
    expect(joined).toContain("来自设置A的回复");
    expect(joined).toContain("来自设置B的回复");
    expect(recorded.completed).toBe(2);
  });

  it("工具事件走结构化通道，不再注入 markdown 文本", async () => {
    const onTool = vi.fn();
    const onDelta = vi.fn();
    // 会调用工具的 provider：首轮返回一次 toolCall（复用本文件既有的
    // createMockProvider 工具回放手法），工具执行后次轮返回最终文本。
    const runtime = new HarnessRuntime({
      ...runtimeOptions([], { workspaceRoot: workspace }),
      hooks: {
        onDelta,
        onTool,
        onThinking: () => {},
        onCompleted: () => {},
        onError: () => {},
        askPermission: async () => "allow",
        log: () => {},
      },
      providerFactory: () =>
        createMockProvider({
          turns: [
            { toolCalls: [{ toolName: "Read", args: { path: "hello.txt" } }] },
            { text: "读完了" },
          ],
        }),
    });
    await chatTurn(runtime, "sess-5", "跑一下测试", "msg_t5");
    const kinds = onTool.mock.calls.map((c) => (c[2] as { type: string }).type);
    expect(kinds).toContain("toolCall");
    expect(kinds).toContain("toolResult");
    expect(onDelta.mock.calls.some((c) => String(c[2]).includes("🔧"))).toBe(false);
  });

  it("activeAgent 决定注入的系统提示词（fake provider 断言 system）", async () => {
    const seenSystems: string[] = [];
    const recorded: Recorded = emptyRecorded();
    const runtime = new HarnessRuntime({
      ...runtimeOptions([{ text: "答" }], { workspaceRoot: workspace, activeAgent: "plan" }, recorded),
      providerFactory: () =>
        createMockProvider({
          turns: [{ text: "答" }],
          onChat: (req) => seenSystems.push(req.system),
        }),
    });

    await chatTurn(runtime, "agent-1", "规划一下", "m-agent-1");

    expect(seenSystems).toEqual([systemPromptFor("plan")]);
    expect(seenSystems[0]).not.toBe(systemPromptFor("default"));
  });
});

describe("HarnessRuntime plugin composition", () => {
  it("creates plugins from the host composition root", async () => {
    const created: string[] = [];
    const disposed: string[] = [];
    const runtime = new HarnessRuntime({
      ...runtimeOptions([{ text: "好" }], { workspaceRoot: workspace }),
      pluginsForSession: async ({ sessionId, workspaceRoot }) => [{
        name: `plugin-${sessionId}`,
        activate() { created.push(workspaceRoot); },
        async dispose() { disposed.push(sessionId); },
      }],
    });

    await chatTurn(runtime, "s1", "hello", "m1");
    await runtime.dispose("s1");
    expect(created).toEqual([expect.any(String)]);
    expect(disposed).toEqual(["s1"]);
  });

  it("hands the factory the full PluginFactoryContext", async () => {
    const contexts: PluginFactoryContext[] = [];
    const runtime = new HarnessRuntime({
      ...runtimeOptions([{ text: "好" }], { workspaceRoot: workspace }),
      pluginsForSession: (context) => {
        contexts.push(context);
        return [];
      },
    });

    await chatTurn(runtime, "ctx-1", "你好", "m-ctx");

    expect(contexts).toHaveLength(1);
    expect(contexts[0].sessionId).toBe("ctx-1");
    expect(contexts[0].messageId).toBe("m-ctx");
    expect(contexts[0].workspaceRoot).toBe(workspace);
    expect(contexts[0].settings).toMatchObject({ workspaceRoot: workspace });
    expect(contexts[0].scope.sessionId).toBe("ctx-1");
    // Plain chat turns normalize to the main route with no task identity.
    expect(contexts[0].routeId).toBe("main");
    expect(contexts[0].taskId).toBeUndefined();
  });

  it("settings change rebuild: copies canonical history, then awaits the old session dispose", async () => {
    const events: string[] = [];
    const seenRequests: string[][] = [];
    const settings: HarnessSettings = { ...DEFAULT_SETTINGS, workspaceRoot: workspace };
    const runtime = new HarnessRuntime({
      ...runtimeOptions([], {}, emptyRecorded()),
      settings: () => settings,
      providerFactory: () =>
        createMockProvider({
          turns: [{ text: "答" }],
          onChat: (req) =>
            seenRequests.push(
              req.messages.map((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text).join("")).filter(Boolean),
            ),
        }),
      pluginsForSession: () => [{
        name: "witness",
        activate() { events.push("activate"); },
        async dispose() {
          events.push("dispose-start");
          await new Promise((resolve) => setTimeout(resolve, 10));
          events.push("dispose-end");
        },
      }],
    });

    await chatTurn(runtime, "rb-1", "一", "m-rb1");
    settings.permissionMode = "plan";
    await chatTurn(runtime, "rb-1", "二", "m-rb2");

    // The rebuilt session carried the canonical history over.
    expect(seenRequests[1]).toEqual(["一", "答", "二"]);
    // The new session is created (and receives the copied history) BEFORE the
    // old one is disposed, and that dispose is fully awaited inside the
    // rebuild — before the new turn's chat runs.
    expect(events).toEqual(["activate", "activate", "dispose-start", "dispose-end"]);
    // disposeAll now releases the rebuilt (cached) session — the second and
    // final witness disposal.
    await runtime.disposeAll();
    expect(events).toEqual([
      "activate", "activate", "dispose-start", "dispose-end", "dispose-start", "dispose-end",
    ]);
  });

  it("dispose() drops the cache so the next send builds a fresh session", async () => {
    const disposed: string[] = [];
    const runtime = new HarnessRuntime({
      ...runtimeOptions([{ text: "好" }], { workspaceRoot: workspace }),
      pluginsForSession: ({ sessionId }) => [{
        name: `p-${sessionId}`,
        activate() {},
        async dispose() { disposed.push(sessionId); },
      }],
    });

    await chatTurn(runtime, "fresh-1", "一", "m-f1");
    await runtime.dispose("fresh-1");
    // Repeated dispose is a no-op (the cached session is gone).
    await runtime.dispose("fresh-1");
    expect(disposed).toEqual(["fresh-1"]);

    await chatTurn(runtime, "fresh-1", "二", "m-f2");
    expect(disposed).toEqual(["fresh-1"]); // the new session is still alive
    await runtime.disposeAll();
    expect(disposed).toEqual(["fresh-1", "fresh-1"]);
  });

  it("disposeAll() releases every cached session", async () => {
    const disposed: string[] = [];
    const runtime = new HarnessRuntime({
      ...runtimeOptions([{ text: "好" }], { workspaceRoot: workspace }),
      pluginsForSession: ({ sessionId }) => [{
        name: `p-${sessionId}`,
        activate() {},
        async dispose() { disposed.push(sessionId); },
      }],
    });

    await chatTurn(runtime, "all-1", "x", "m-a1");
    await chatTurn(runtime, "all-2", "y", "m-a2");
    await runtime.disposeAll();

    expect([...disposed].sort()).toEqual(["all-1", "all-2"]);
    // disposeAll cleared the cache: a second sweep finds nothing.
    await runtime.disposeAll();
    expect([...disposed].sort()).toEqual(["all-1", "all-2"]);
  });
});

describe("HarnessRuntime build/dispose races", () => {
  it("dispose during an in-flight build releases the landing session instead of leaking it", async () => {
    const events: string[] = [];
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const recorded: Recorded = emptyRecorded();
    const runtime = new HarnessRuntime({
      ...runtimeOptions([{ text: "迟到的回复" }], { workspaceRoot: workspace }, recorded),
      // Slow composition root pins the build window open (MCP spawns can
      // span seconds in production).
      pluginsForSession: async () => {
        await factoryGate;
        return [{
          name: "slow-plugin",
          activate() { events.push("activate"); },
          async dispose() { events.push("dispose"); },
        }];
      },
    });

    const sending = chatTurn(runtime, "race-1", "你好", "m-race");
    // The send is now parked inside the in-flight build (factory gated).
    const disposing = runtime.dispose("race-1");
    releaseFactory();
    await Promise.all([sending, disposing]);

    // The turn failed fast instead of running to completion on a session
    // the user already deleted.
    expect(recorded.completed).toBe(0);
    expect(recorded.errors).toHaveLength(1);
    expect(recorded.errors[0]).toContain("会话已释放");
    // The landing session's plugins were released — no AgentSession leak.
    expect(events).toEqual(["activate", "dispose"]);
    // Nothing is left cached or building: further dispose calls are no-ops.
    await runtime.dispose("race-1");
    await runtime.disposeAll();
    expect(events).toEqual(["activate", "dispose"]);
  });

  it("overlapping sends share one in-flight build (single AgentSession per chat session)", async () => {
    let factoryCalls = 0;
    const recorded: Recorded = emptyRecorded();
    const runtime = new HarnessRuntime({
      ...runtimeOptions([{ text: "答A" }, { text: "答B" }], { workspaceRoot: workspace }, recorded),
      pluginsForSession: () => {
        factoryCalls += 1;
        return [];
      },
    });

    const first = chatTurn(runtime, "dup-1", "一", "m-d1");
    const second = chatTurn(runtime, "dup-1", "二", "m-d2");
    await Promise.all([first, second]);

    // One build for both sends — a dropped loser would leak its plugins
    // (e.g. an MCP child-process tree nobody disposes).
    expect(factoryCalls).toBe(1);
    expect(recorded.errors).toEqual([]);
    expect(recorded.completed).toBe(2);
  });

  it("dispose failures surface through the error-level log hook and never reject", async () => {
    const logs: Array<{ level: string; msg: string }> = [];
    const recorded: Recorded = emptyRecorded();
    const runtime = new HarnessRuntime({
      ...runtimeOptions([{ text: "好" }], { workspaceRoot: workspace }, recorded),
      hooks: {
        ...makeHooks(recorded),
        log: (level, msg) => logs.push({ level, msg }),
      },
      pluginsForSession: () => [{
        name: "boom",
        activate() {},
        async dispose() { throw new Error("plugin teardown exploded"); },
      }],
    });

    await chatTurn(runtime, "boom-1", "hi", "m-b1");
    await expect(runtime.dispose("boom-1")).resolves.toBeUndefined();

    // The failure reached the host log with the error level intact — the
    // glue's log hook must route it to logger.error, not downgrade to info.
    expect(logs).toContainEqual({ level: "error", msg: "session dispose failed" });
  });

  it("dispose() gives up on a stuck in-flight build after a bounded timeout (quit path never hangs)", async () => {
    vi.useFakeTimers();
    try {
      const logs: Array<{ level: string; msg: string; data: string }> = [];
      const events: string[] = [];
      const recorded: Recorded = emptyRecorded();
      // Deferred factory pins the build window open — a hung MCP spawn.
      let releaseBuild!: () => void;
      const buildGate = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      const runtime = new HarnessRuntime({
        ...runtimeOptions([{ text: "迟到的回复" }], { workspaceRoot: workspace }, recorded),
        hooks: {
          ...makeHooks(recorded),
          log: (level, msg, data) => logs.push({ level, msg, data: String(data) }),
        },
        pluginsForSession: async () => {
          await buildGate;
          return [{
            name: "stuck-plugin",
            activate() { events.push("activate"); },
            async dispose() { events.push("dispose"); },
          }];
        },
      });

      const sending = chatTurn(runtime, "stuck-1", "你好", "m-stuck");
      // Let dispose() run past its synchronous cache release so the bounded
      // wait's timer is registered before the clock advances.
      const disposing = runtime.dispose("stuck-1");
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(IN_FLIGHT_BUILD_DISPOSE_TIMEOUT_MS + 10);

      // Quit path is free: dispose resolved despite the still-pending build.
      await expect(disposing).resolves.toBeUndefined();
      expect(logs).toContainEqual({
        level: "error",
        msg: "dispose timed out waiting for in-flight build",
        data: "stuck-1:main", // identified by the route cache key now
      });

      // The tombstone OUTLIVES the timeout: the build landing after dispose
      // already returned self-releases instead of repopulating the cache.
      releaseBuild();
      await sending;
      expect(events).toEqual(["activate", "dispose"]);
      expect(recorded.errors).toHaveLength(1);
      expect(recorded.errors[0]).toContain("会话已释放");
      // Nothing leaked into the cache: a later sweep finds no session.
      await runtime.disposeAll();
      expect(events).toEqual(["activate", "dispose"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a send after a dispose timeout fails fast instead of joining the doomed build", async () => {
    vi.useFakeTimers();
    try {
      const recorded: Recorded = emptyRecorded();
      // The stuck build NEVER lands in this scenario — joining it would park
      // the new turn forever.
      const buildGate = new Promise<void>(() => {});
      const runtime = new HarnessRuntime({
        ...runtimeOptions([{ text: "迟到的回复" }], { workspaceRoot: workspace }, recorded),
        pluginsForSession: async () => {
          await buildGate;
          return [];
        },
      });

      void chatTurn(runtime, "doomed-1", "一", "m-d1"); // parks on the stuck build
      const disposing = runtime.dispose("doomed-1");
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(IN_FLIGHT_BUILD_DISPOSE_TIMEOUT_MS + 10);
      await expect(disposing).resolves.toBeUndefined();

      // New send on the same id: it must error IMMEDIATELY (no clock advance
      // needed, no waiting on the never-settling build) via onError.
      const second = chatTurn(runtime, "doomed-1", "二", "m-d2");
      await expect(second).resolves.toBeUndefined();
      expect(recorded.completed).toBe(0);
      expect(recorded.errors).toHaveLength(1);
      expect(recorded.errors[0]).toContain("会话已释放");
      expect(recorded.errors[0]).toContain("请重建会话");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HarnessRuntime route forks", () => {
  it("delegates the exact forkRoute request to the host route port", async () => {
    const input = {
      sessionId: "s1",
      taskId: "t1",
      sourceRouteId: "main",
      sourceTurnId: "a2",
      mode: "retry-assistant" as const,
      routeName: "Retry a2",
    };
    const route = {
      routeId: "child",
      parentRouteId: "main",
      forkTurnId: "a2",
      checkpointId: "c1",
      workspaceRoot: "D:/wt/child",
      readonly: false,
    };
    const forkRoute = vi.fn(async () => route);
    const runtime = new HarnessRuntime({
      ...runtimeOptions([], { workspaceRoot: workspace }),
      forkRoute,
    });

    await expect(runtime.forkRoute(input)).resolves.toEqual(route);
    expect(forkRoute).toHaveBeenCalledWith(input);
  });
});

describe("HarnessRuntime route cache", () => {
  it("does not share AgentSession history between routes", async () => {
    const agentFactory = recordingAgentFactory();
    const runtime = new HarnessRuntime({
      ...runtimeOptions([{ text: "答" }], { workspaceRoot: workspace }),
      pluginsForSession: () => [],
      agentFactory: agentFactory.factory,
    });

    await runtime.send({ sessionId: "s1", routeId: "main", taskId: "t1", text: "main", messageId: "m1" });
    await runtime.send({ sessionId: "s1", routeId: "child", taskId: "t1", text: "child", messageId: "m2" });

    expect(agentFactory.sessions.get("s1:main")?.history).not.toBe(agentFactory.sessions.get("s1:child")?.history);
    // Both routes really built their own session (not an undefined/undefined pass),
    // and the child route's agent never saw the main route's conversation.
    expect(agentFactory.sessions.size).toBe(2);
    const childHistory = agentFactory.sessions.get("s1:child")!.history;
    expect(
      childHistory.some((m) => m.parts.some((p) => p.type === "text" && p.text.includes("main"))),
    ).toBe(false);
  });

  it("dispose(sessionId, routeId) releases only that route's agent; dispose(sessionId) releases all", async () => {
    const disposed: string[] = [];
    const runtime = new HarnessRuntime({
      ...runtimeOptions([{ text: "好" }], { workspaceRoot: workspace }),
      pluginsForSession: ({ sessionId, routeId }) => [{
        name: `p-${sessionId}:${routeId}`,
        activate() {},
        async dispose() { disposed.push(`${sessionId}:${routeId}`); },
      }],
    });

    await runtime.send({ sessionId: "s1", routeId: "main", taskId: "", text: "一", messageId: "m1" });
    await runtime.send({ sessionId: "s1", routeId: "child", taskId: "", text: "二", messageId: "m2" });

    await runtime.dispose("s1", "child");
    expect(disposed).toEqual(["s1:child"]);
    // The main route's agent is still cached: a repeat dispose is a no-op there.
    await runtime.dispose("s1", "child");
    expect(disposed).toEqual(["s1:child"]);

    // An EMPTY routeId normalizes to the main route (like send), never a
    // dead key that silently matches nothing.
    await runtime.dispose("s1", "");
    expect(disposed).toEqual(["s1:child", "s1:main"]);
    runtime.stop("s1", ""); // no throw, no dead-key leak

    await runtime.dispose("s1");
    expect([...disposed].sort()).toEqual(["s1:child", "s1:main"]);
  });

  it("roots a task route's session at the route-resolved workspace, not the settings root", async () => {
    const taskWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-task-ws-"));
    try {
      const agentFactory = recordingAgentFactory();
      const contexts: PluginFactoryContext[] = [];
      const runtime = new HarnessRuntime({
        ...runtimeOptions([{ text: "答" }], { workspaceRoot: workspace }, emptyRecorded()),
        pluginsForSession: (context) => {
          contexts.push(context);
          return [];
        },
        agentFactory: agentFactory.factory,
        // Task routes resolve to the task's effective workspace (its
        // worktree); everything else keeps the settings root.
        workspaceRootFor: ({ taskId }) => (taskId === "t1" ? taskWorkspace : undefined),
      });

      await runtime.send({ sessionId: "root-1", routeId: "child", taskId: "t1", text: "x", messageId: "m-r1" });
      await runtime.send({ sessionId: "root-1", routeId: "main", taskId: "", text: "y", messageId: "m-r2" });

      const child = agentFactory.sessions.get("root-1:child")!;
      expect(child.workspaceRoot).toBe(taskWorkspace);
      expect(contexts[0].workspaceRoot).toBe(taskWorkspace); // plugins compose against it too
      expect(agentFactory.sessions.get("root-1:main")!.workspaceRoot).toBe(workspace);
      await runtime.disposeAll();
    } finally {
      await fs.rm(taskWorkspace, { recursive: true, force: true });
    }
  });

  it("a failed build leaves the route buildable again (no stale build context)", async () => {
    let fail = true;
    const recorded: Recorded = emptyRecorded();
    const runtime = new HarnessRuntime({
      ...runtimeOptions([{ text: "好" }], { workspaceRoot: workspace }, recorded),
      pluginsForSession: () => {
        if (fail) {
          fail = false;
          throw new Error("factory boom");
        }
        return [];
      },
    });

    await chatTurn(runtime, "retry-1", "一", "m-r1");
    expect(recorded.errors).toHaveLength(1);
    expect(recorded.completed).toBe(0);

    await chatTurn(runtime, "retry-1", "二", "m-r2");
    expect(recorded.completed).toBe(1);
    expect(recorded.errors).toHaveLength(1);
  });

  it("persists non-main route turns as turn-v3 rows that never re-enter the main history", async () => {
    const recorded: Recorded = emptyRecorded();
    const seenRequests: string[][] = [];
    const runtime = new HarnessRuntime({
      ...runtimeOptions([], { workspaceRoot: workspace }, recorded),
      providerFactory: () =>
        createMockProvider({
          turns: [{ text: "答" }],
          onChat: (req) =>
            seenRequests.push(
              req.messages.map((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text).join("")).filter(Boolean),
            ),
        },
      ),
    });

    await runtime.send({ sessionId: "routes-1", routeId: "main", taskId: "", text: "主轮问题", messageId: "turn-main" });
    await runtime.send({ sessionId: "routes-1", routeId: "child", taskId: "", text: "子轮问题", messageId: "turn-child" });

    const raw = await fs.readFile(path.join(persistDir, "routes-1.jsonl"), "utf8");
    const rows = raw.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((r) => r.type)).toEqual(["turn-v2", "turn-v3"]);
    expect(rows[1].routeId).toBe("child");
    expect(rows[1].turnId).toBe("turn-child");
    // decodeTranscript keeps the child route out of the main history...
    const decoded = decodeTranscript(raw);
    expect(
      decoded.history.some((m) => m.parts.some((p) => p.type === "text" && p.text.includes("子轮"))),
    ).toBe(false);
    expect(decoded.routes.get("child")?.turnIds).toEqual(["turn-child"]);

    // ...so a restart seeds only the main route's agent with the main history.
    const restarted = new HarnessRuntime({
      ...runtimeOptions([], { workspaceRoot: workspace }, recorded),
      providerFactory: () =>
        createMockProvider({
          turns: [{ text: "再答" }],
          onChat: (req) =>
            seenRequests.push(
              req.messages.map((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text).join("")).filter(Boolean),
            ),
        }),
    });
    await runtime.disposeAll();
    await restarted.send({ sessionId: "routes-1", routeId: "main", taskId: "", text: "重启后", messageId: "turn-restart" });
    expect(seenRequests.at(-1)).toEqual(["主轮问题", "答", "重启后"]);
  });

  it("skips runtime-side persistence for task-scoped turns (the task commit flow owns them)", async () => {
    const recorded: Recorded = emptyRecorded();
    const runtime = makeRuntime([{ text: "答" }], { workspaceRoot: workspace }, recorded);

    await runtime.send({ sessionId: "task-1", routeId: "child", taskId: "t9", text: "任务轮", messageId: "turn-task" });

    await expect(fs.access(path.join(persistDir, "task-1.jsonl"))).rejects.toThrow();
  });

  it("hands task identity to the plugin factory and stamps it on tool invocation scopes", async () => {
    const contexts: PluginFactoryContext[] = [];
    const invocationScopes: Array<{ taskId?: string; routeId?: string }> = [];
    const toolIndexLookups: Array<unknown> = [];
    const probe = {
      name: "Probe",
      description: "records its invocation scope",
      readOnly: true,
      sideEffect: "none" as const,
      parameters: { type: "object" as const, properties: {} },
      permissionResource: () => ({ action: "read" as const, kind: "path" as const, scope: "probe.txt" }),
      persistArgs: (args: Record<string, unknown>) => ({ ...args }),
      async execute(
        _args: Record<string, unknown>,
        ctx: { scope: { taskId?: string; routeId?: string } },
      ) {
        invocationScopes.push({ taskId: ctx.scope.taskId, routeId: ctx.scope.routeId });
        return { content: "probed" };
      },
    };
    const runtime = new HarnessRuntime({
      ...runtimeOptions(
        [{ toolCalls: [{ toolName: "Probe", args: {} }] }, { text: "done" }],
        { workspaceRoot: workspace, permissionMode: "full" },
        emptyRecorded(),
      ),
      pluginsForSession: (context) => {
        contexts.push(context);
        return [{
          name: "probe-tools",
          activate(ctx) {
            ctx.registerTool(probe);
          },
          // Execution happens after the runtime adopted the session's registry:
          // the late-bound tool index must resolve tools by name by then.
          dispose() {
            toolIndexLookups.push(context.toolIndex.get("Probe")?.name);
          },
        }];
      },
    });

    await runtime.send({ sessionId: "scope-1", routeId: "child", taskId: "t9", text: "跑探针", messageId: "m-scope" });

    expect(contexts).toHaveLength(1);
    expect(contexts[0].taskId).toBe("t9");
    expect(contexts[0].routeId).toBe("child");
    expect(contexts[0].scope.taskId).toBe("t9");
    expect(contexts[0].scope.routeId).toBe("child");
    expect(invocationScopes).toEqual([{ taskId: "t9", routeId: "child" }]);
    await runtime.disposeAll();
    expect(toolIndexLookups).toEqual(["Probe"]);
  });
});
