import { describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../src/index";

const SSE = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1}}}',
  "",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"开始"}}',
  "",
  'data: {"type":"content_block_stop","index":0}',
  "",
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"Read","input":{}}}',
  "",
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
  "",
  'data: {"type":"content_block_stop","index":1}',
  "",
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":33}}',
  "",
  'data: {"type":"message_stop"}',
  "",
].join("\n");

describe("createAnthropicProvider full path (stubbed fetch)", () => {
  it("streams text and complete tool calls with correct wire shape", async () => {
    let capturedURL = "";
    let capturedInit: RequestInit | undefined;
    const provider = createAnthropicProvider({
      apiKey: "test-key",
      model: "claude-sonnet-4-5",
      fetchImpl: async (url, init) => {
        capturedURL = String(url);
        capturedInit = init;
        return new Response(SSE, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const deltas = [];
    for await (const d of provider.chat({
      system: "s",
      tools: [{ name: "Read", description: "r", parameters: { type: "object" } }],
      messages: [{ role: "user", parts: [{ type: "text", text: "读一下" }] }],
    })) {
      deltas.push(d);
    }

    expect(capturedURL).toBe("https://api.anthropic.com/v1/messages");
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const wireBody = JSON.parse(String(capturedInit!.body));
    expect(wireBody.model).toBe("claude-sonnet-4-5");
    expect(wireBody.max_tokens).toBe(8192);
    expect(wireBody.system).toBe("s");

    expect(deltas[0]).toEqual({ type: "usage", inputTokens: 9, outputTokens: 0 });
    expect(deltas[1]).toEqual({ type: "text", text: "开始" });
    expect(deltas.at(-1)).toEqual({
      type: "toolCall",
      id: "toolu_9",
      toolName: "Read",
      args: { path: "a.ts" },
    });
  });

  it("thinking_delta 思考增量转成 thinking delta", async () => {
    const sse = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
      "",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"盘算"}}',
      "",
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"回答"}}',
      "",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");
    const provider = createAnthropicProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: async () => new Response(sse, { status: 200 }),
    });
    const deltas = [];
    for await (const d of provider.chat({ system: "s", messages: [], tools: [] })) {
      deltas.push(d);
    }
    expect(deltas).toEqual([
      { type: "thinking", text: "盘算" },
      { type: "text", text: "回答" },
    ]);
  });

  it("surfaces HTTP errors with status and body snippet", async () => {
    const provider = createAnthropicProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: async () => new Response('{"type":"error"}', { status: 529 }),
    });
    await expect(
      (async () => {
        for await (const _ of provider.chat({ system: "s", messages: [], tools: [] })) {
          break;
        }
      })(),
    ).rejects.toThrow("Anthropic HTTP 529");
  });

  it("throws early without an API key", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => createAnthropicProvider({ model: "m" })).toThrow("API key");
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
