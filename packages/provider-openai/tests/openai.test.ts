import { describe, expect, it } from "vitest";
import type { ChatRequest } from "@innocencecode/harness-providers";
import { toOpenAIBody } from "../src/mapping";
import { openAIDeltasFromDataLines } from "../src/stream";
import type { Delta } from "@innocencecode/harness-providers";

async function* lines(arr: string[]): AsyncIterable<string> {
  yield* arr;
}

async function collect(src: string[]): Promise<Delta[]> {
  const out: Delta[] = [];
  for await (const d of openAIDeltasFromDataLines(lines(src))) out.push(d);
  return out;
}

// Payload strings as parseSSEData yields them (the `data:` prefix is already
// stripped upstream); the full-path tests cover the prefix-stripping layer.
const chunk = (o: object) => JSON.stringify(o);

// ---- Recorded-format SSE fixtures -------------------------------------------

const TEXT_ONLY = [
  chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "你好" }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { content: "，世界" }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  chunk({ choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  "data: [DONE]",
];

const TEXT_AND_TOOL = [
  chunk({ choices: [{ index: 0, delta: { content: "让我读一下" }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "Read", arguments: "" } }] }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a' } }] }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
  "data: [DONE]",
];

const MULTIPLE_TOOLS = [
  chunk({ choices: [{ index: 0, delta: { tool_calls: [
    { index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: '{"path":"x"}' } },
    { index: 1, id: "call_2", type: "function", function: { name: "Grep", arguments: '{"pat' } },
  ] }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: 'tern":"foo"}' } }] }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
  "data: [DONE]",
];

const ERROR_STREAM = [
  chunk({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }),
  "data: [DONE]",
];

// -----------------------------------------------------------------------------

describe("openAIDeltasFromDataLines (fixture replay)", () => {
  it("streams pure text and reports usage", async () => {
    const deltas = await collect(TEXT_ONLY);
    expect(deltas).toEqual([
      { type: "text", text: "你好" },
      { type: "text", text: "，世界" },
      { type: "usage", inputTokens: 10, outputTokens: 5 },
    ]);
  });

  it("aggregates fragmented tool-call arguments into one complete call", async () => {
    const deltas = await collect(TEXT_AND_TOOL);
    expect(deltas[0]).toEqual({ type: "text", text: "让我读一下" });
    expect(deltas[1]).toEqual({
      type: "toolCall",
      id: "call_abc",
      toolName: "Read",
      args: { path: "a.ts" },
    });
    expect(deltas).toHaveLength(2);
  });

  it("aggregates multiple parallel tool calls in index order", async () => {
    const deltas = await collect(MULTIPLE_TOOLS);
    const calls = deltas.filter((d) => d.type === "toolCall");
    expect(calls.map((c) => (c as { toolName: string }).toolName)).toEqual(["Read", "Grep"]);
    expect(calls[1]).toMatchObject({ args: { pattern: "foo" } });
  });

  it("throws on in-stream error payloads", async () => {
    await expect(collect(ERROR_STREAM)).rejects.toThrow("Incorrect API key");
  });
});

describe("toOpenAIBody", () => {
  const req: ChatRequest = {
    system: "be helpful",
    tools: [{ name: "Read", description: "read", parameters: { type: "object" } }],
    messages: [
      { role: "user", parts: [{ type: "text", text: "读 a.ts" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "好的" },
          { type: "toolCall", id: "c1", toolName: "Read", args: { path: "a.ts" } },
        ],
      },
      {
        role: "user",
        parts: [
          { type: "toolResult", toolCallId: "c1", content: "1\thello" },
          { type: "text", text: "然后呢" },
        ],
      },
    ],
  };

  it("maps system, tool results to role:tool, tool specs to function format", () => {
    const body = toOpenAIBody(req, { model: "gpt-4o" }) as Record<string, any>;
    expect(body.model).toBe("gpt-4o");
    expect(body.stream).toBe(true);
    const msgs = body.messages;
    expect(msgs[0]).toEqual({ role: "system", content: "be helpful" });
    expect(msgs[1]).toEqual({ role: "user", content: "读 a.ts" });
    expect(msgs[2].tool_calls[0]).toMatchObject({
      id: "c1",
      type: "function",
      function: { name: "Read", arguments: '{"path":"a.ts"}' },
    });
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "1\thello" });
    expect(msgs[4]).toEqual({ role: "user", content: "然后呢" });
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "Read" } });
  });

  it("omits tools when none are provided", () => {
    const body = toOpenAIBody(
      { system: "s", tools: [], messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] },
      { model: "m" },
    ) as Record<string, unknown>;
    expect("tools" in body).toBe(false);
  });

  it("reasoning_effort: 设置档位时携带，off/未设置时省略", () => {
    const base = {
      system: "s",
      tools: [],
      messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] }],
    };
    expect(toOpenAIBody(base, { model: "m", reasoningEffort: "high" }).reasoning_effort).toBe("high");
    // max（GLM 系"最高"）原样透传，由端点解释
    expect(toOpenAIBody(base, { model: "m", reasoningEffort: "max" }).reasoning_effort).toBe("max");
    expect(toOpenAIBody(base, { model: "m", reasoningEffort: "off" }).reasoning_effort).toBeUndefined();
    expect(toOpenAIBody(base, { model: "m" }).reasoning_effort).toBeUndefined();
  });
});
