import { describe, expect, it } from "vitest";
import { Context } from "@innocencecode/kernel";
import { ProvidersPlugin } from "@innocencecode/harness-providers";
import { createOpenAIPlugin, createOpenAIProvider } from "../src/index";

const SSE = [
  'data: {"choices":[{"index":0,"delta":{"content":"让我读"}}]}',
  "",
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"Read","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}',
  "",
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
  "",
  "data: [DONE]",
  "",
].join("\n");

describe("createOpenAIProvider full path (stubbed fetch)", () => {
  it("streams text and complete tool calls; wire body is mapped correctly", async () => {
    let capturedURL = "";
    let capturedInit: RequestInit | undefined;
    const provider = createOpenAIProvider({
      apiKey: "test-key",
      model: "gpt-4o",
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

    expect(capturedURL).toBe("https://api.openai.com/v1/chat/completions");
    expect((capturedInit!.headers as Record<string, string>).authorization).toBe(
      "Bearer test-key",
    );
    const wireBody = JSON.parse(String(capturedInit!.body));
    expect(wireBody.model).toBe("gpt-4o");
    expect(wireBody.messages[0]).toEqual({ role: "system", content: "s" });

    expect(deltas).toEqual([
      { type: "text", text: "让我读" },
      { type: "toolCall", id: "call_x", toolName: "Read", args: { path: "a.ts" } },
    ]);
  });

  it("reasoning_content / reasoning 思考增量转成 thinking delta", async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"先想"}}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{"reasoning":"再想"}}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{"content":"答案"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const provider = createOpenAIProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: async () => new Response(sse, { status: 200 }),
    });
    const deltas = [];
    for await (const d of provider.chat({ system: "s", messages: [], tools: [] })) {
      deltas.push(d);
    }
    expect(deltas).toEqual([
      { type: "thinking", text: "先想" },
      { type: "thinking", text: "再想" },
      { type: "text", text: "答案" },
    ]);
  });

  it("surfaces HTTP errors with status and body snippet", async () => {
    const provider = createOpenAIProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: async () => new Response('{"error":{"message":"rate limited"}}', { status: 429 }),
    });
    await expect(
      (async () => {
        for await (const _ of provider.chat({ system: "s", messages: [], tools: [] })) {
          break;
        }
      })(),
    ).rejects.toThrow("OpenAI HTTP 429");
  });

  it("throws early without an API key", () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => createOpenAIProvider({ model: "m" })).toThrow("API key");
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });
});

describe("createOpenAIPlugin (kernel mount)", () => {
  it("registers the OpenAI provider on the spine providers service", async () => {
    const ctx = new Context();
    await ctx.plugin(ProvidersPlugin);
    const plugin = createOpenAIPlugin({ apiKey: "k", model: "m" });
    expect(plugin.name).toBe("provider-openai");
    await ctx.plugin(plugin);
    expect(ctx.providers.get("openai")).toBeDefined();
  });
});
