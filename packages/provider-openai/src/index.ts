import { parseSSEData, type HarnessPlugin, type Provider } from "@innocencecode/harness-core";
import { toOpenAIBody } from "./mapping";
import { openAIDeltasFromDataLines } from "./stream";

export interface OpenAIProviderConfig {
  apiKey?: string;
  /** Override for OpenAI-compatible endpoints (Ollama, vLLM, gateways...). */
  baseURL?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  /** Provider id for the registry; default "openai". */
  id?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export function createOpenAIProvider(config: OpenAIProviderConfig): Provider {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 OpenAI API key（config.apiKey 或环境变量 OPENAI_API_KEY）");
  }
  const baseURL = (config.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const doFetch = config.fetchImpl ?? fetch;

  return {
    id: config.id ?? "openai",

    async *chat(req) {
      const res = await doFetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(
          toOpenAIBody(req, {
            model: config.model,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
          }),
        ),
        signal: req.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`OpenAI HTTP ${res.status}：${text.slice(0, 300)}`);
      }
      if (!res.body) throw new Error("OpenAI 响应没有 body");
      yield* openAIDeltasFromDataLines(parseSSEData(res.body));
    },
  };
}

/** Plugin wrapper for uniform registration. */
export const openAIPlugin = (config: OpenAIProviderConfig): HarnessPlugin => ({
  name: "provider-openai",
  activate(ctx) {
    ctx.registerProvider(createOpenAIProvider(config));
  },
});

export { toOpenAIBody } from "./mapping";
export { openAIDeltasFromDataLines } from "./stream";
