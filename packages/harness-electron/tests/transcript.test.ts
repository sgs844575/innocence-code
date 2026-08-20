import { describe, expect, it } from "vitest";
import type { Message } from "@innocencecode/harness-core";
import {
  canonicalizeHistory,
  decodeTranscript,
  encodeTurnV2,
  encodeTurnV3,
  type TurnRecordV3,
} from "../src/transcript";

const pair = (user: string, answer: string): Message[] => [
  { role: "user", parts: [{ type: "text", text: user }] },
  { role: "assistant", parts: [{ type: "text", text: answer }] },
];
const text = (m: Message) => m.parts.filter((p) => p.type === "text").map((p) => p.text).join("");

describe("legacy transcript decoding", () => {
  it("累计快照 + 重启独立片段 + 重复用户文本：每行只取本轮，无遗漏无重复", () => {
    const a = pair("你好", "答A");
    const b = pair("分析项目", "答B");
    const c = pair("插件有哪些", "答C");
    const d = pair("你好", "答D"); // 用户文本与第 1 轮相同，仍必须保留
    const raw = [
      JSON.stringify({ at: "t1", type: "turn", user: "你好", history: a }),
      JSON.stringify({ at: "t2", type: "turn", user: "分析项目", history: [...a, ...b] }),
      JSON.stringify({ at: "t3", type: "turn", user: "插件有哪些", history: c }), // restart fragment
      JSON.stringify({ at: "t4", type: "turn", user: "你好", history: [...c, ...d] }),
    ].join("\n");
    const decoded = decodeTranscript(raw);
    expect(decoded.validRecords).toBe(4);
    expect(decoded.history.map(text)).toEqual([
      "你好", "答A", "分析项目", "答B", "插件有哪些", "答C", "你好", "答D",
    ]);
  });

  it("UI 归并工具结果形状与 canonical 形状解码为同一逻辑轮", () => {
    const uiMessages: Message[] = [
      { role: "user", parts: [{ type: "text", text: "跑测试" }] },
      { role: "assistant", parts: [
        { type: "text", text: "执行" },
        { type: "toolCall", id: "c1", toolName: "Bash", args: { command: "npm test" } },
        { type: "toolResult", toolCallId: "c1", content: "ok", isError: false },
        { type: "text", text: "完成" },
      ] },
    ];
    const canonical = canonicalizeHistory(uiMessages);
    expect(canonical.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const raw = JSON.stringify({ at: "t", type: "turn", user: "跑测试", history: uiMessages });
    expect(decodeTranscript(raw).history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("可解析但只有未完成 user 的 legacy 行不造空历史", () => {
    const raw = JSON.stringify({
      at: "t",
      type: "turn",
      user: "中断了",
      history: [{ role: "user", parts: [{ type: "text", text: "中断了" }] }],
    });
    const decoded = decodeTranscript(raw);
    expect(decoded.validRecords).toBe(1);
    expect(decoded.history).toEqual([]);
  });
});

describe("turn-v2 append-only protocol", () => {
  it("每条只含本轮，turnId 重复时去重", () => {
    const line1 = encodeTurnV2("turn-a", "t1", pair("问1", "答1"));
    const line2 = encodeTurnV2("turn-b", "t2", pair("问2", "答2"));
    const duplicate = encodeTurnV2("turn-b", "t3", pair("问2", "重复答2"));
    const decoded = decodeTranscript(line1 + line2 + duplicate);
    expect(decoded.history.map(text)).toEqual(["问1", "答1", "问2", "答2"]);
  });
});

const v3 = (over: Partial<TurnRecordV3> & { turnId: string; routeId: string }): string =>
  encodeTurnV3({
    at: "t0",
    eventId: "event-0",
    parentTurnId: null,
    checkpointId: "cp-0",
    messages: pair("问", "答"),
    ...over,
  });

describe("turn-v3 route-aware decoding", () => {
  it("reads v2 as main route and preserves v3 route ancestry", () => {
    const v2Line = encodeTurnV2("old-turn", "t1", pair("问1", "答1"));
    const v3ChildRouteLine = v3({
      at: "t2",
      eventId: "event-1",
      turnId: "child-turn",
      routeId: "child",
      parentTurnId: "old-turn",
      checkpointId: "cp-1",
    });
    const decoded = decodeTranscript(v2Line + v3ChildRouteLine);
    expect(decoded.routes.get("main")?.turnIds).toEqual(["old-turn"]);
    expect(decoded.routes.get("child")?.parentTurnId).toBe("old-turn");
    expect(decoded.routes.get("child")?.turnIds).toEqual(["child-turn"]);
  });

  it("merges v3 main-route turns with v2 turns; child-route turns stay out of main history", () => {
    const raw =
      encodeTurnV2("old-turn", "t1", pair("问1", "答1")) +
      v3({ at: "t2", eventId: "e1", turnId: "new-turn", routeId: "main", checkpointId: "cp-1", messages: pair("问2", "答2") }) +
      v3({ at: "t3", eventId: "e2", turnId: "child-turn", routeId: "child", parentTurnId: "new-turn", messages: pair("子问", "子答") });
    const decoded = decodeTranscript(raw);
    expect(decoded.routes.get("main")?.turnIds).toEqual(["old-turn", "new-turn"]);
    expect(decoded.routes.get("child")?.parentTurnId).toBe("new-turn");
    expect(decoded.history.map(text)).toEqual(["问1", "答1", "问2", "答2"]);
  });

  it("restores multi-level ancestry through the parentTurnId chain", () => {
    const raw =
      v3({ at: "t1", eventId: "e1", turnId: "t-main-2", routeId: "main" }) +
      v3({ at: "t2", eventId: "e2", turnId: "t-a", routeId: "route-a", parentTurnId: "t-main-2" }) +
      v3({ at: "t3", eventId: "e3", turnId: "t-b", routeId: "route-b", parentTurnId: "t-a" });
    const decoded = decodeTranscript(raw);
    expect(decoded.routes.get("route-a")?.parentTurnId).toBe("t-main-2");
    expect(decoded.routes.get("route-b")?.parentTurnId).toBe("t-a");
    expect(decoded.history.map(text)).toEqual(["问", "答"]);
  });

  it("round-trips an encoded v3 record through decode", () => {
    const messages: Message[] = [
      { role: "user", parts: [{ type: "text", text: "跑" }] },
      { role: "assistant", parts: [{ type: "toolCall", id: "c1", toolName: "Bash", args: { command: "npm test" } }] },
      { role: "user", parts: [{ type: "toolResult", toolCallId: "c1", content: "ok", isError: false }] },
    ];
    const line = v3({ at: "t9", eventId: "e9", turnId: "turn-9", routeId: "main", messages });
    const decoded = decodeTranscript(line);
    expect(decoded.validRecords).toBe(1);
    expect(decoded.routes.get("main")?.turnIds).toEqual(["turn-9"]);
    expect(decoded.history).toHaveLength(3);
    expect(decoded.lastAt).toBe("t9");
  });
});

describe("unknown part preservation", () => {
  it("keeps unknown legal parts on the message instead of dropping them (v3)", () => {
    const raw =
      JSON.stringify({
        at: "t1",
        type: "turn-v3",
        eventId: "e1",
        turnId: "turn-x",
        routeId: "main",
        parentTurnId: null,
        checkpointId: "cp-1",
        messages: [
          { role: "user", parts: [{ type: "text", text: "附件" }, { type: "attachment", ref: "file://a.png" }] },
          { role: "assistant", parts: [{ type: "text", text: "收到" }, { type: "attachment", ref: "file://b.png" }] },
        ],
      }) + "\n";
    const decoded = decodeTranscript(raw);
    expect(decoded.history).toHaveLength(2);
    const [userMessage, assistantMessage] = decoded.history;
    expect(userMessage.parts).toEqual([{ type: "text", text: "附件" }]);
    expect(userMessage.preservedParts).toEqual([{ type: "attachment", ref: "file://a.png" }]);
    // 未来 part 不得被误归为 tool part：assistant 不因此拆出 user 结果块
    expect(decoded.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(assistantMessage.parts.map((p) => p.type)).toEqual(["text"]);
    expect(assistantMessage.preservedParts).toEqual([{ type: "attachment", ref: "file://b.png" }]);
  });

  it("keeps unknown parts of legacy v2 rows readable too", () => {
    const raw =
      JSON.stringify({
        at: "t1",
        type: "turn-v2",
        turnId: "old-turn",
        messages: [{ role: "assistant", parts: [{ type: "futureThing", id: 7 }, { type: "text", text: "答" }] }],
      }) + "\n";
    const decoded = decodeTranscript(raw);
    expect(decoded.history).toHaveLength(1);
    expect(decoded.history[0]?.parts.map((p) => p.type)).toEqual(["text"]);
    expect(decoded.history[0]?.preservedParts).toEqual([{ type: "futureThing", id: 7 }]);
  });

  it("round-trips preserved parts through canonicalizeHistory without aliasing", () => {
    const source = [
      {
        role: "assistant",
        parts: [
          { type: "text", text: "答" },
          { type: "attachment", ref: "file://c.png" },
        ],
      },
    ];
    const canonical = canonicalizeHistory(source);
    expect(canonical[0]?.preservedParts).toEqual([{ type: "attachment", ref: "file://c.png" }]);
    const encoded = v3({ turnId: "turn-p", routeId: "main", messages: canonical });
    const decodedAgain = decodeTranscript(encoded);
    expect(decodedAgain.history[0]?.preservedParts).toEqual([{ type: "attachment", ref: "file://c.png" }]);
  });
});
