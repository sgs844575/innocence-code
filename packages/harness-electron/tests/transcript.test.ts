import { describe, expect, it } from "vitest";
import type { Message } from "@innocencecode/harness-core";
import { canonicalizeHistory, decodeTranscript, encodeTurnV2 } from "../src/transcript";

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
