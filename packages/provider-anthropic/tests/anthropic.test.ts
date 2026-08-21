import { describe, expect, it } from "vitest";
import type { ChatRequest, Delta } from "@innocencecode/harness-providers";
import { toAnthropicBody } from "../src/mapping";
import { anthropicDeltasFromDataLines } from "../src/stream";

async function* lines(arr: string[]): AsyncIterable<string> {
  yield* arr;
}

async function collect(src: string[]): Promise<Delta[]> {
  const out: Delta[] = [];
  for await (const d of anthropicDeltasFromDataLines(lines(src))) out.push(d);
  return out;
}

// Payload strings as parseSSEData yields them (the `data:` prefix is already
// stripped upstream); the full-path tests cover the prefix-stripping layer.
const chunk = (o: object) => JSON.stringify(o);

// ---- Recorded-format SSE fixtures -------------------------------------------

const TEXT_ONLY = [
  chunk({ type: "message_start", message: { usage: { input_tokens: 25, output_tokens: 1 } } }),
  chunk({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  chunk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } }),
  chunk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "！" } }),
  chunk({ type: "content_block_stop", index: 0 }),
  chunk({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } }),
  chunk({ type: "message_stop" }),
];

const TEXT_AND_TOOL = [
  chunk({ type: "message_start", message: { usage: { input_tokens: 25, output_tokens: 1 } } }),
  chunk({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  chunk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我来看看" } }),
  chunk({ type: "content_block_stop", index: 0 }),
  chunk({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "Read", input: {} } }),
  chunk({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"' } }),
  chunk({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'a.ts"}' } }),
  chunk({ type: "content_block_stop", index: 1 }),
  chunk({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } }),
  chunk({ type: "message_stop" }),
];

const MULTIPLE_TOOLS = [
  chunk({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_a", name: "Read", input: {} } }),
  chunk({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"x"}' } }),
  chunk({ type: "content_block_stop", index: 0 }),
  chunk({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_b", name: "Grep", input: {} } }),
  chunk({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pattern":"foo"}' } }),
  chunk({ type: "content_block_stop", index: 1 }),
  chunk({ type: "message_stop" }),
];

const ERROR_STREAM = [
  chunk({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
];

// -----------------------------------------------------------------------------

describe("anthropicDeltasFromDataLines (fixture replay)", () => {
  it("streams text with usage from message_start and message_delta", async () => {
    const deltas = await collect(TEXT_ONLY);
    expect(deltas).toEqual([
      { type: "usage", inputTokens: 25, outputTokens: 0 },
      { type: "text", text: "你好" },
      { type: "text", text: "！" },
      { type: "usage", inputTokens: 25, outputTokens: 12 },
    ]);
  });

  it("aggregates tool_use input fragments into a complete call", async () => {
    const deltas = await collect(TEXT_AND_TOOL);
    expect(deltas[0]).toMatchObject({ type: "usage", inputTokens: 25 });
    expect(deltas[1]).toEqual({ type: "text", text: "我来看看" });
    expect(deltas.at(-1)).toEqual({
      type: "toolCall",
      id: "toolu_01",
      toolName: "Read",
      args: { path: "a.ts" },
    });
  });

  it("emits multiple tool calls in block order", async () => {
    const deltas = await collect(MULTIPLE_TOOLS);
    const calls = deltas.filter((d) => d.type === "toolCall");
    expect(calls.map((c) => (c as { toolName: string }).toolName)).toEqual(["Read", "Grep"]);
    expect(calls[0]).toMatchObject({ id: "toolu_a", args: { path: "x" } });
    expect(calls[1]).toMatchObject({ id: "toolu_b", args: { pattern: "foo" } });
  });

  it("throws on error events", async () => {
    await expect(collect(ERROR_STREAM)).rejects.toThrow("Overloaded");
  });
});

describe("toAnthropicBody", () => {
  it("maps near 1:1 with canonical blocks", () => {
    const req: ChatRequest = {
      system: "sys",
      tools: [{ name: "Read", description: "r", parameters: { type: "object" } }],
      messages: [
        { role: "user", parts: [{ type: "text", text: "读 a.ts" }] },
        {
          role: "assistant",
          parts: [{ type: "toolCall", id: "c1", toolName: "Read", args: { path: "a.ts" } }],
        },
        {
          role: "user",
          parts: [{ type: "toolResult", toolCallId: "c1", content: "1\thello" }],
        },
      ],
    };
    const body = toAnthropicBody(req, { model: "claude-sonnet-4-5" }) as Record<string, any>;
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.max_tokens).toBe(8192);
    expect(body.system).toBe("sys");
    expect(body.messages[1].content[0]).toEqual({
      type: "tool_use",
      id: "c1",
      name: "Read",
      input: { path: "a.ts" },
    });
    expect(body.messages[2].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "c1",
      content: "1\thello",
    });
    expect(body.tools[0]).toMatchObject({ name: "Read", input_schema: { type: "object" } });
  });

  it("reasoningEffort 映射 thinking 预算并抬高 max_tokens；off/未设置不开启", () => {
    const base = {
      system: "s",
      tools: [],
      messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] }],
    };
    const high = toAnthropicBody(base, { model: "m", reasoningEffort: "high" }) as Record<string, any>;
    expect(high.thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
    expect(high.max_tokens).toBeGreaterThanOrEqual(32768 + 8192); // 预算之上留输出空间
    expect(toAnthropicBody(base, { model: "m", reasoningEffort: "max" }).thinking).toEqual({
      type: "enabled",
      budget_tokens: 65536,
    });
    expect(toAnthropicBody(base, { model: "m", reasoningEffort: "off" }).thinking).toBeUndefined();
    expect(toAnthropicBody(base, { model: "m" }).thinking).toBeUndefined();
  });

  it("drops empty-text parts and empty messages", () => {
    const body = toAnthropicBody(
      {
        system: "",
        tools: [],
        messages: [
          { role: "user", parts: [{ type: "text", text: "" }] },
          { role: "user", parts: [{ type: "text", text: "hi" }] },
        ],
      },
      { model: "m" },
    ) as Record<string, any>;
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect("system" in body).toBe(false);
  });
});
