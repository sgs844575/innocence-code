import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockProvider, type MockTurn } from "@innocencecode/provider-mock";
import {
  DEFAULT_SETTINGS,
  HarnessRuntime,
  decodeTranscript,
  type AskResponse,
  type HarnessSettings,
  type LiveToolPart,
  type RuntimeHooks,
} from "../src";

let persistDir: string;
let workspace: string;

interface Recorded {
  deltas: string[];
  tools: LiveToolPart[];
  completed: number;
  errors: string[];
  asks: Array<{ toolName: string; answer: AskResponse }>;
}

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

function makeRuntime(
  turns: MockTurn[],
  settings: Partial<HarnessSettings> = {},
  recorded: Recorded,
  answer: AskResponse = "allow",
) {
  const full: HarnessSettings = { ...DEFAULT_SETTINGS, ...settings };
  return new HarnessRuntime({
    settings: () => full,
    hooks: makeHooks(recorded, answer),
    persistDir,
    providerFactory: () => createMockProvider({ turns }),
  });
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
    const recorded: Recorded = { deltas: [], tools: [], completed: 0, errors: [], asks: [] };
    const runtime = makeRuntime([{ text: "你好，我是回复" }], { workspaceRoot: workspace }, recorded);

    await runtime.send("sess-1", "打个招呼", "msg_t1");

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
    const rec1: Recorded = { deltas: [], tools: [], completed: 0, errors: [], asks: [] };
    const first = new HarnessRuntime({
      settings: () => full,
      hooks: makeHooks(rec1),
      persistDir,
      providerFactory: () => createMockProvider({ turns: [{ text: "第一答" }] }),
    });
    await first.send("sess-restart", "第一问", "turn-1");

    // New runtime instance = fully closed/reopened app.
    const rec2: Recorded = { deltas: [], tools: [], completed: 0, errors: [], asks: [] };
    const seenRequests: string[][] = [];
    const second = new HarnessRuntime({
      settings: () => full,
      hooks: makeHooks(rec2),
      persistDir,
      providerFactory: () =>
        createMockProvider({
          turns: [{ text: "第二答" }],
          onChat: (req) =>
            seenRequests.push(req.messages.map((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text).join(""))),
        }),
    });
    await second.send("sess-restart", "第二问", "turn-2");

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
    const recorded: Recorded = { deltas: [], tools: [], completed: 0, errors: [], asks: [] };
    const runtime = makeRuntime(
      [
        { toolCalls: [{ toolName: "Read", args: { path: "hello.txt" } }] },
        { text: "读完了" },
      ],
      { workspaceRoot: workspace, permissionMode: "ask" },
      recorded,
      "allow",
    );

    await runtime.send("sess-2", "读 hello.txt", "msg_t2");

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
    const recorded: Recorded = { deltas: [], tools: [], completed: 0, errors: [], asks: [] };
    const runtime = makeRuntime(
      [
        { toolCalls: [{ toolName: "Write", args: { path: "x.txt", content: "nope" } }] },
        { text: "好吧，我不写了" },
      ],
      { workspaceRoot: workspace, permissionMode: "ask" },
      recorded,
      "deny",
    );

    await runtime.send("sess-3", "写 x.txt", "msg_t3");

    expect(recorded.asks).toHaveLength(1);
    const joined = recorded.deltas.join("");
    expect(joined).toContain("好吧，我不写了");
    expect(
      recorded.tools.some((p) => p.type === "toolResult" && p.isError === true),
    ).toBe(true);
    await expect(fs.access(path.join(workspace, "x.txt"))).rejects.toThrow();
  });

  it("rebuilds the cached agent session when settings change, keeping history", async () => {
    const recorded: Recorded = { deltas: [], tools: [], completed: 0, errors: [], asks: [] };
    const settings: HarnessSettings = { ...DEFAULT_SETTINGS, workspaceRoot: workspace };
    let currentTurns: MockTurn[] = [{ text: "来自设置A的回复" }];
    const runtime = new HarnessRuntime({
      settings: () => settings,
      hooks: makeHooks(recorded),
      persistDir,
      providerFactory: () => createMockProvider({ turns: currentTurns }),
    });

    await runtime.send("sess-4", "一", "msg_t4a");
    // Same runtime, new settings hash -> cached session rebuilt with the
    // previous conversation carried over, new provider takes effect.
    currentTurns = [{ text: "来自设置B的回复" }];
    settings.permissionMode = "plan";
    await runtime.send("sess-4", "二", "msg_t4b");

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
      settings: () => ({ ...DEFAULT_SETTINGS, workspaceRoot: workspace }),
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
    await runtime.send("sess-5", "跑一下测试", "msg_t5");
    const kinds = onTool.mock.calls.map((c) => (c[2] as { type: string }).type);
    expect(kinds).toContain("toolCall");
    expect(kinds).toContain("toolResult");
    expect(onDelta.mock.calls.some((c) => String(c[2]).includes("🔧"))).toBe(false);
  });
});
