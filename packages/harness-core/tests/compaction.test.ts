import { describe, expect, it } from "vitest";
import {
  ContextManager,
  SUMMARIZE_SYSTEM_PROMPT,
  estimateTokens,
  findSplitIndex,
  textMessage,
  type Delta,
  type Provider,
} from "../src";

function summarizingProvider(seen: string[] = []): Provider {
  return {
    id: "summarizer",
    async *chat(req): AsyncIterable<Delta> {
      seen.push(req.system);
      if (req.system !== SUMMARIZE_SYSTEM_PROMPT) {
        yield { type: "text", text: "final" };
        return;
      }
      yield { type: "text", text: "这是压缩后的摘要。" };
    },
  };
}

describe("estimateTokens / findSplitIndex", () => {
  it("grows with content", () => {
    expect(estimateTokens([textMessage("user", "hello world")])).toBeGreaterThan(0);
  });

  it("splits only on plain user text messages and keeps the recent tail", () => {
    const msgs = [
      textMessage("user", "q1"),
      textMessage("assistant", "a1"),
      textMessage("user", "q2"),
      textMessage("assistant", "a2"),
      textMessage("user", "q3"),
      textMessage("assistant", "a3"),
    ];
    // keepRecent=3 -> maxSplit=3 -> messages[3] is assistant, walk back to 2 (user q2).
    expect(findSplitIndex(msgs, 3)).toBe(2);
    // keepRecent too large -> no safe split.
    expect(findSplitIndex(msgs, 10)).toBe(0);
  });

  it("never splits on a message carrying tool results", () => {
    const msgs = [
      textMessage("user", "q1"),
      textMessage("assistant", "a1"),
      {
        role: "user" as const,
        parts: [{ type: "toolResult" as const, toolCallId: "c1", content: "r" }],
      },
      textMessage("assistant", "a2"),
      textMessage("user", "q2"),
    ];
    expect(findSplitIndex(msgs, 2)).toBe(0);
  });
});

describe("ContextManager.maybeCompact", () => {
  it("does nothing under threshold", async () => {
    const cm = new ContextManager({ maxContextTokens: 1_000_000 });
    const messages = [textMessage("user", "hi")];
    const changed = await cm.maybeCompact(messages, summarizingProvider());
    expect(changed).toBe(false);
    expect(messages).toHaveLength(1);
  });

  it("replaces old turns with a summary message, keeps tail verbatim", async () => {
    const cm = new ContextManager({ maxContextTokens: 1, keepRecent: 2 });
    const messages = [
      textMessage("user", "第一个问题，很长很长".repeat(20)),
      textMessage("assistant", "第一个回答"),
      textMessage("user", "第二个问题"),
      textMessage("assistant", "第二个回答"),
      textMessage("user", "第三个问题"),
      textMessage("assistant", "第三个回答"),
    ];
    const seen: string[] = [];
    const changed = await cm.maybeCompact(messages, summarizingProvider(seen));
    expect(changed).toBe(true);
    expect(seen).toContain(SUMMARIZE_SYSTEM_PROMPT);
    expect(messages[0].parts[0]).toMatchObject({ type: "text" });
    expect((messages[0].parts[0] as { text: string }).text).toContain("压缩后的摘要");
    // tail preserved verbatim
    expect(messages[messages.length - 2]).toEqual(textMessage("user", "第三个问题"));
    expect(messages[messages.length - 1]).toEqual(textMessage("assistant", "第三个回答"));
  });

  it("is a no-op when no safe split exists even over threshold", async () => {
    const cm = new ContextManager({ maxContextTokens: 1, keepRecent: 2 });
    const messages = [
      textMessage("user", "x".repeat(200)),
      textMessage("assistant", "y".repeat(200)),
    ];
    const changed = await cm.maybeCompact(messages, summarizingProvider());
    expect(changed).toBe(false);
    expect(messages).toHaveLength(2);
  });
});
