// packages/harness-electron/src/modelPresets.ts
// 模型预设元数据：上下文/输出/能力/思考档位默认值。
//
// 数据分三层合并（后者覆盖前者同名条目）：
//   1. cherry 规范模型表（presets/models.json，ownedBy 厂牌归属）
//   2. cherry 厂商别名表（presets/provider-models.json，API 原始 id → 规范 id）
//   3. MANUAL 手工层（cherry 未覆盖/需校正的条目，优先级最高）
// 全部数据来自 cherry-studio packages/provider-registry（MIT）的完整编译产物，
// 再生成方法见 presets/README.md。
//
// 查找是【厂家无关】的：先按厂家表精确命中，之后回退到全局索引（精确 →
// 点/下划线归一化）——中转站/网关厂商名下出现任何家的模型 id 都能拿到元数据。
// 所有数值只是默认值，用户在编辑抽屉里改过的字段以 dirty 标记保护（见 settings v3）。

import cherryModelsJson from "./presets/models.json";
import cherryOverridesJson from "./presets/provider-models.json";

export interface PresetModelMeta {
  name?: string;
  group?: string;
  contextWindow?: number;
  maxInput?: number;
  maxOutput?: number;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  /** 支持的思考档位（openai reasoning_effort 风格，如 minimal/low/medium/high）。 */
  reasoningEfforts?: string[];
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
  reasoningEfforts?: string[];
  streaming?: boolean;
  source: ModelSource;
  /** 用户手改保护：enrich 不覆盖已 dirty 模型的任何字段。 */
  dirty?: boolean;
}

// ---- cherry registry 数据形状（用到的字段） ----------------------------------

interface CherryReasoning {
  supportedEfforts?: string[];
  controls?: { kind?: string; values?: string[] }[];
}

interface CherryModel {
  id: string;
  name?: string;
  ownedBy?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: string[];
  reasoning?: CherryReasoning;
}

interface CherryOverride {
  providerId: string;
  modelId: string;
  apiModelId?: string;
  name?: string;
}

/** 我们的预设厂家名 → cherry 定位（id 用于别名表；owners 是规范模型的
 *  ownedBy 厂牌 id——上游 ownedBy 用厂牌而非供应商，如 gemini→google、
 *  Grok→xai、Qwen→alibaba；网关型厂商（硅基/OpenRouter/Ollama）无自有
 *  规范条目，纯靠别名表）。 */
const CHERRY_PROVIDER: Record<string, { id: string; owners: string[] }> = {
  OpenAI: { id: "openai", owners: ["openai"] },
  Anthropic: { id: "anthropic", owners: ["anthropic"] },
  DeepSeek: { id: "deepseek", owners: ["deepseek"] },
  Gemini: { id: "gemini", owners: ["google"] },
  阿里云百炼: { id: "dashscope", owners: ["alibaba"] },
  智谱开放平台: { id: "zhipu", owners: ["zhipu"] },
  Moonshot: { id: "moonshot", owners: ["moonshot"] },
  xAI: { id: "grok", owners: ["xai"] },
  Mistral: { id: "mistral", owners: ["mistral"] },
  硅基流动: { id: "silicon", owners: [] },
  OpenRouter: { id: "openrouter", owners: [] },
  "Ollama 本地": { id: "ollama", owners: [] },
};

function effortsOf(e: CherryModel): string[] | undefined {
  if (!e.reasoning) return undefined;
  const list = e.reasoning.supportedEfforts ?? e.reasoning.controls?.find((c) => c.kind === "effort")?.values;
  return list && list.length > 0 ? list : undefined;
}

function toMeta(e: CherryModel): PresetModelMeta | null {
  const caps = e.capabilities ?? [];
  const meta: PresetModelMeta = {};
  if (typeof e.contextWindow === "number") meta.contextWindow = e.contextWindow;
  if (typeof e.maxOutputTokens === "number") meta.maxOutput = e.maxOutputTokens;
  if (e.name) meta.name = e.name;
  if (caps.includes("function-call")) meta.tools = true;
  if (caps.includes("image-recognition")) meta.vision = true;
  if (caps.includes("reasoning")) {
    meta.reasoning = true;
    const efforts = effortsOf(e);
    if (efforts) meta.reasoningEfforts = efforts;
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

const CHERRY_MODELS = (cherryModelsJson as { models: CherryModel[] }).models;
const CHERRY_OVERRIDES = (cherryOverridesJson as { overrides: CherryOverride[] }).overrides;

/** 规范 id → 元数据（全库）。 */
const CANONICAL = new Map<string, PresetModelMeta>();
for (const e of CHERRY_MODELS) {
  const meta = toMeta(e);
  if (meta) CANONICAL.set(e.id, meta);
}

/** cherry 厂商 id →（API 原始 id → 规范元数据）。 */
const ALIASES = new Map<string, Map<string, PresetModelMeta>>();
/** 全局别名索引：任何 API 原始 id → 规范元数据（厂家无关回退用）。 */
const GLOBAL_ALIAS = new Map<string, PresetModelMeta>();
for (const o of CHERRY_OVERRIDES) {
  const meta = CANONICAL.get(o.modelId);
  if (!meta) continue;
  const withName = o.name ? { ...meta, name: o.name } : meta;
  const per = ALIASES.get(o.providerId) ?? new Map<string, PresetModelMeta>();
  per.set(o.apiModelId ?? o.modelId, withName);
  ALIASES.set(o.providerId, per);
  GLOBAL_ALIAS.set(o.apiModelId ?? o.modelId, GLOBAL_ALIAS.get(o.apiModelId ?? o.modelId) ?? withName);
}

// ---- 手工层：cherry 数据的缺口与校正（优先级最高） ----------------------------
// （表内容见下；reasoning 档位不手工指定——统一交给 cherry 数据或 UI 通用档位）

const MANUAL: Record<string, Record<string, PresetModelMeta>> = {
  OpenAI: {
    "gpt-5": { contextWindow: 400000, maxOutput: 128000, tools: true, reasoning: true },
    "gpt-5-mini": { contextWindow: 400000, maxOutput: 128000, tools: true, reasoning: true },
    "gpt-5-nano": { contextWindow: 400000, maxOutput: 128000, tools: true, reasoning: true },
    "gpt-4.1": { contextWindow: 1047576, maxOutput: 32768, tools: true },
    "gpt-4.1-mini": { contextWindow: 1047576, maxOutput: 32768, tools: true },
    "gpt-4.1-nano": { contextWindow: 1047576, maxOutput: 32768, tools: true },
    "gpt-4o": { contextWindow: 128000, maxOutput: 16384, vision: true, tools: true },
    "gpt-4o-mini": { contextWindow: 128000, maxOutput: 16384, vision: true, tools: true },
    o3: { contextWindow: 200000, maxOutput: 100000, tools: true, reasoning: true },
    "o4-mini": { contextWindow: 200000, maxOutput: 100000, tools: true, reasoning: true },
    o1: { contextWindow: 200000, maxOutput: 100000, reasoning: true },
  },
  Anthropic: {
    "claude-opus-4-5": { contextWindow: 200000, maxOutput: 32000, tools: true },
    "claude-sonnet-4-5": { contextWindow: 200000, maxOutput: 32000, tools: true },
    "claude-haiku-4-5": { contextWindow: 200000, maxOutput: 32000, tools: true },
    "claude-opus-4-1": { contextWindow: 200000, maxOutput: 32000, tools: true },
    "claude-sonnet-4-5-20250929": { contextWindow: 200000, maxOutput: 32000, tools: true },
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
    "zai-org/GLM-4.6": { contextWindow: 200000, maxOutput: 8192, tools: true },
    "moonshotai/Kimi-K2-Instruct": { contextWindow: 262144, maxOutput: 16384, tools: true },
  },
  OpenRouter: {
    "openai/gpt-5": { contextWindow: 400000, maxOutput: 128000, tools: true, reasoning: true },
    "anthropic/claude-sonnet-4.5": { contextWindow: 200000, maxOutput: 32000, tools: true },
    "google/gemini-2.5-pro": { contextWindow: 1048576, maxOutput: 65536, vision: true, tools: true, reasoning: true },
    "x-ai/grok-4": { contextWindow: 256000, maxOutput: 32768, tools: true, reasoning: true },
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

// ---- 三层合并 ------------------------------------------------------------------

export const PRESET_MODELS: Record<string, Record<string, PresetModelMeta>> = (() => {
  const out: Record<string, Record<string, PresetModelMeta>> = {};
  for (const [name, { id, owners }] of Object.entries(CHERRY_PROVIDER)) {
    const table: Record<string, PresetModelMeta> = {};
    const ownerSet = new Set(owners);
    for (const e of CHERRY_MODELS) {
      if (!e.ownedBy || !ownerSet.has(e.ownedBy)) continue;
      const meta = toMeta(e);
      if (meta) table[e.id] = meta;
    }
    for (const [apiId, meta] of ALIASES.get(id) ?? []) {
      table[apiId] ??= meta; // 别名不覆盖同名规范条目
    }
    Object.assign(table, MANUAL[name] ?? {}); // 手工层最优先
    out[name] = table;
  }
  for (const name of Object.keys(MANUAL)) out[name] ??= MANUAL[name]!;
  return out;
})();

/** 点/下划线 → 连字符、小写：cherry 规范 id 是连字符风格（gemini-2-5-pro），
 *  API 原始 id 常是点风格（gemini-2.5-pro）——归一化后做模糊回退。 */
const norm = (id: string): string => id.replace(/[._]/g, "-").toLowerCase();

const NORMALIZED: Record<string, Map<string, PresetModelMeta>> = {};
for (const [name, table] of Object.entries(PRESET_MODELS)) {
  const map = new Map<string, PresetModelMeta>();
  for (const [id, meta] of Object.entries(table)) map.set(norm(id), meta);
  NORMALIZED[name] = map;
}

/** 全局归一化索引（别名 ∪ 规范，厂家无关）。 */
const GLOBAL_NORM = new Map<string, PresetModelMeta>();
for (const [id, meta] of [...GLOBAL_ALIAS, ...CANONICAL]) {
  const key = norm(id);
  GLOBAL_NORM.set(key, GLOBAL_NORM.get(key) ?? meta);
}

/** 厂家无关的元数据解析：厂家表精确 → 厂家归一化 → 全局别名 → 全局规范 →
 *  全局归一化。中转站（自定义厂家）名下的任何家模型 id 都能命中。 */
export function resolvePresetMeta(providerName: string, modelId: string): PresetModelMeta | undefined {
  return (
    PRESET_MODELS[providerName]?.[modelId] ??
    NORMALIZED[providerName]?.get(norm(modelId)) ??
    GLOBAL_ALIAS.get(modelId) ??
    CANONICAL.get(modelId) ??
    GLOBAL_NORM.get(norm(modelId))
  );
}

/** 由预设生成落库模型对象；无元数据时生成仅含 id 的最小对象。 */
export function modelFromPreset(providerName: string, modelId: string): ModelInfo {
  const meta = resolvePresetMeta(providerName, modelId);
  if (!meta) return { id: modelId, source: "preset" };
  return { id: modelId, source: "preset", ...meta };
}
