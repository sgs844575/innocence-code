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
    "gpt-4o": { contextWindow: 128000, maxOutput: 16384, vision: true, tools: true },
    "gpt-4o-mini": { contextWindow: 128000, maxOutput: 16384, vision: true, tools: true },
    "o3": { contextWindow: 200000, maxOutput: 100000, tools: true, reasoning: true },
  },
  Anthropic: {
    "claude-sonnet-4-5": { contextWindow: 200000, maxOutput: 16384, tools: true },
    "claude-opus-4-1": { contextWindow: 200000, maxOutput: 32000, tools: true },
  },
  DeepSeek: {
    "deepseek-chat": { contextWindow: 65536, maxOutput: 8192, tools: true },
    "deepseek-reasoner": { contextWindow: 65536, maxOutput: 8192, reasoning: true },
  },
  硅基流动: {
    "deepseek-ai/DeepSeek-V3.2": { contextWindow: 131072, maxOutput: 8192, tools: true },
    "Qwen/Qwen3-32B": { contextWindow: 131072, maxOutput: 8192, tools: true },
  },
  OpenRouter: {
    "openai/gpt-4o": { contextWindow: 128000, maxOutput: 16384, vision: true, tools: true },
    "anthropic/claude-sonnet-4": { contextWindow: 200000, maxOutput: 16384, tools: true },
  },
  智谱开放平台: {
    "glm-4-plus": { contextWindow: 128000, maxOutput: 4096, tools: true },
    "glm-4-flash": { contextWindow: 128000, maxOutput: 4096, tools: true },
    "glm-4.6": { contextWindow: 200000, maxOutput: 8192, tools: true },
    "glm-4.5-air": { contextWindow: 128000, maxOutput: 4096, tools: true },
  },
  Moonshot: {
    "kimi-k2-0905-preview": { contextWindow: 262144, maxOutput: 16384, tools: true },
    "moonshot-v1-32k": { contextWindow: 32768, maxOutput: 8192, tools: true },
  },
  "Ollama 本地": {
    "qwen3:8b": { contextWindow: 32768, tools: true },
    "llama3.1:8b": { contextWindow: 131072, tools: true },
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
