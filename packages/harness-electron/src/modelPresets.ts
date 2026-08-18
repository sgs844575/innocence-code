// packages/harness-electron/src/modelPresets.ts
// 模型预设元数据：上下文/输出/能力默认值（cherry registry 的子集形状）。
// 键 = PROVIDER_PRESETS 的厂家名；值 = 该厂家常见模型的元数据。
// 所有数值只是默认值，用户在编辑抽屉里改过的字段以 dirty 标记保护（见 settings v3）。

export interface PresetModelMeta {
  name?: string;
  group?: string;
  contextWindow?: number;
  maxInput?: number;
  maxOutput?: number;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
}

export type ModelSource = "preset" | "fetch" | "manual";

export interface ModelInfo {
  id: string;
  name?: string;
  group?: string;
  contextWindow?: number;
  maxInput?: number;
  maxOutput?: number;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  streaming?: boolean;
  source: ModelSource;
  /** 用户手改保护：enrich 不覆盖已 dirty 模型的任何字段。 */
  dirty?: boolean;
}

export const PRESET_MODELS: Record<string, Record<string, PresetModelMeta>> = {
  OpenAI: {
    "gpt-5": { contextWindow: 400000, maxOutput: 128000, tools: true, reasoning: true },
    "gpt-5-mini": { contextWindow: 400000, maxOutput: 128000, tools: true, reasoning: true },
    "gpt-5-nano": { contextWindow: 400000, maxOutput: 128000, tools: true, reasoning: true },
    "gpt-4.1": { contextWindow: 1047576, maxOutput: 32768, tools: true },
    "gpt-4.1-mini": { contextWindow: 1047576, maxOutput: 32768, tools: true },
    "gpt-4.1-nano": { contextWindow: 1047576, maxOutput: 32768, tools: true },
    "gpt-4o": { contextWindow: 128000, maxOutput: 16384, vision: true, tools: true },
    "gpt-4o-mini": { contextWindow: 128000, maxOutput: 16384, vision: true, tools: true },
    "o3": { contextWindow: 200000, maxOutput: 100000, tools: true, reasoning: true },
    "o4-mini": { contextWindow: 200000, maxOutput: 100000, tools: true, reasoning: true },
    "o1": { contextWindow: 200000, maxOutput: 100000, reasoning: true },
  },
  Anthropic: {
    "claude-opus-4-5": { contextWindow: 200000, maxOutput: 32000, tools: true },
    "claude-sonnet-4-5": { contextWindow: 200000, maxOutput: 32000, tools: true },
    "claude-haiku-4-5": { contextWindow: 200000, maxOutput: 32000, tools: true },
    "claude-opus-4-1": { contextWindow: 200000, maxOutput: 32000, tools: true },
    "claude-sonnet-4-5-20250929": { contextWindow: 200000, maxOutput: 32000, tools: true },
    "claude-3-7-sonnet-20250219": { contextWindow: 200000, maxOutput: 64000, tools: true },
    "claude-3-5-haiku-20241022": { contextWindow: 200000, maxOutput: 8192, tools: true },
  },
  DeepSeek: {
    "deepseek-chat": { contextWindow: 131072, maxOutput: 8192, tools: true },
    "deepseek-reasoner": { contextWindow: 131072, maxOutput: 8192, reasoning: true, tools: true },
  },
  Gemini: {
    "gemini-2.5-pro": { contextWindow: 1048576, maxOutput: 65536, vision: true, tools: true, reasoning: true },
    "gemini-2.5-flash": { contextWindow: 1048576, maxOutput: 65536, vision: true, tools: true, reasoning: true },
    "gemini-2.5-flash-lite": { contextWindow: 1048576, maxOutput: 65536, vision: true, tools: true },
    "gemini-2.0-flash": { contextWindow: 1048576, maxOutput: 8192, vision: true, tools: true },
  },
  阿里云百炼: {
    "qwen3-max": { contextWindow: 262144, maxOutput: 16384, tools: true, reasoning: true },
    "qwen-max": { contextWindow: 262144, maxOutput: 8192, tools: true },
    "qwen-plus": { contextWindow: 131072, maxOutput: 8192, tools: true },
    "qwen-turbo": { contextWindow: 1000000, maxOutput: 8192, tools: true },
    "qwen-long": { contextWindow: 10000000, maxOutput: 8192, tools: true },
    "qwen3-235b-a22b": { contextWindow: 131072, maxOutput: 8192, tools: true, reasoning: true },
    "qwen3-32b": { contextWindow: 131072, maxOutput: 8192, tools: true },
    "qwen-vl-max": { contextWindow: 32768, maxOutput: 2048, vision: true },
  },
  智谱开放平台: {
    "glm-4.6": { contextWindow: 200000, maxOutput: 8192, tools: true },
    "glm-4.5": { contextWindow: 200000, maxOutput: 8192, tools: true },
    "glm-4.5-air": { contextWindow: 131072, maxOutput: 4096, tools: true },
    "glm-4.5-flash": { contextWindow: 131072, maxOutput: 8192, tools: true },
    "glm-4-plus": { contextWindow: 128000, maxOutput: 4096, tools: true },
    "glm-4-flash": { contextWindow: 128000, maxOutput: 4096, tools: true },
  },
  Moonshot: {
    "kimi-k2-0905-preview": { contextWindow: 262144, maxOutput: 16384, tools: true },
    "kimi-k2-turbo-preview": { contextWindow: 262144, maxOutput: 16384, tools: true },
    "moonshot-v1-128k": { contextWindow: 131072, maxOutput: 8192, tools: true },
    "moonshot-v1-32k": { contextWindow: 32768, maxOutput: 8192, tools: true },
    "moonshot-v1-8k": { contextWindow: 8192, maxOutput: 8192, tools: true },
  },
  xAI: {
    "grok-4": { contextWindow: 256000, maxOutput: 32768, tools: true, reasoning: true },
    "grok-4-fast": { contextWindow: 256000, maxOutput: 32768, tools: true, reasoning: true },
    "grok-3": { contextWindow: 131072, maxOutput: 32768, tools: true },
    "grok-3-mini": { contextWindow: 131072, maxOutput: 32768, tools: true, reasoning: true },
    "grok-2-vision-1212": { contextWindow: 131072, maxOutput: 32768, vision: true },
  },
  Mistral: {
    "mistral-large-latest": { contextWindow: 131072, maxOutput: 8192, tools: true },
    "mistral-medium-latest": { contextWindow: 131072, maxOutput: 8192, tools: true, reasoning: true },
    "mistral-small-latest": { contextWindow: 131072, maxOutput: 8192, tools: true },
    "pixtral-large-latest": { contextWindow: 131072, maxOutput: 8192, vision: true, tools: true },
    "open-mistral-nemo": { contextWindow: 131072, maxOutput: 8192 },
  },
  硅基流动: {
    "deepseek-ai/DeepSeek-V3.2": { contextWindow: 131072, maxOutput: 8192, tools: true },
    "deepseek-ai/DeepSeek-R1": { contextWindow: 65536, maxOutput: 16384, reasoning: true, tools: true },
    "Qwen/Qwen3-235B-A22B": { contextWindow: 131072, maxOutput: 8192, tools: true, reasoning: true },
    "Qwen/Qwen3-32B": { contextWindow: 131072, maxOutput: 8192, tools: true },
    "zai-org/GLM-4.6": { contextWindow: 200000, maxOutput: 8192, tools: true },
    "moonshotai/Kimi-K2-Instruct": { contextWindow: 262144, maxOutput: 16384, tools: true },
  },
  OpenRouter: {
    "openai/gpt-5": { contextWindow: 400000, maxOutput: 128000, tools: true, reasoning: true },
    "openai/gpt-4o": { contextWindow: 128000, maxOutput: 16384, vision: true, tools: true },
    "anthropic/claude-sonnet-4.5": { contextWindow: 200000, maxOutput: 32000, tools: true },
    "google/gemini-2.5-pro": { contextWindow: 1048576, maxOutput: 65536, vision: true, tools: true, reasoning: true },
    "google/gemini-2.5-flash": { contextWindow: 1048576, maxOutput: 65536, vision: true, tools: true, reasoning: true },
    "deepseek/deepseek-chat-v3.1": { contextWindow: 131072, maxOutput: 8192, tools: true },
    "x-ai/grok-4": { contextWindow: 256000, maxOutput: 32768, tools: true, reasoning: true },
    "qwen/qwen3-235b-a22b": { contextWindow: 131072, maxOutput: 8192, tools: true, reasoning: true },
  },
  "Ollama 本地": {
    "qwen3:32b": { contextWindow: 131072, tools: true },
    "qwen3:8b": { contextWindow: 32768, tools: true },
    "qwen2.5-coder:7b": { contextWindow: 32768, tools: true },
    "deepseek-r1:8b": { contextWindow: 131072, reasoning: true },
    "llama3.1:8b": { contextWindow: 131072, tools: true },
    "llama3.2:3b": { contextWindow: 131072 },
    "gemma3:12b": { contextWindow: 131072, vision: true },
    "mistral:7b": { contextWindow: 32768 },
  },
};

export function resolvePresetMeta(providerName: string, modelId: string): PresetModelMeta | undefined {
  return PRESET_MODELS[providerName]?.[modelId];
}

/** 由预设生成落库模型对象；无元数据时生成仅含 id 的最小对象。 */
export function modelFromPreset(providerName: string, modelId: string): ModelInfo {
  const meta = resolvePresetMeta(providerName, modelId);
  if (!meta) return { id: modelId, source: "preset" };
  return { id: modelId, source: "preset", ...meta };
}
