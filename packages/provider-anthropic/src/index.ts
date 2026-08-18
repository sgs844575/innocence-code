import { parseSSEData, type HarnessPlugin, type Provider } from "@innocencecode/harness-core";
import { toAnthropicBody } from "./mapping";
import { anthropicDeltasFromDataLines } from "./stream";

export interface AnthropicProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  id?: string;
  fetchImpl?: typeof fetch;
}

export function createAnthropicProvider(config: AnthropicProviderConfig): Provider {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 Anthropic API key（config.apiKey 或环境变量 ANTHROPIC_API_KEY）");
  }
  const baseURL = (config.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const doFetch = config.fetchImpl ?? fetch;

  return {
    id: config.id ?? "anthropic",

    async *chat(req) {
      const res = await doFetch(`${baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(
          toAnthropicBody(req, {
            model: config.model,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
          }),
        ),
        signal: req.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Anthropic HTTP ${res.status}：${text.slice(0, 300)}`);
      }
      if (!res.body) throw new Error("Anthropic 响应没有 body");
      yield* anthropicDeltasFromDataLines(parseSSEData(res.body));
    },
  };
}

/** Plugin wrapper for uniform registration. */
export const anthropicPlugin = (config: AnthropicProviderConfig): HarnessPlugin => ({
  name: "provider-anthropic",
  activate(ctx) {
    ctx.registerProvider(createAnthropicProvider(config));
  },
});

export { toAnthropicBody } from "./mapping";
export { anthropicDeltasFromDataLines } from "./stream";
