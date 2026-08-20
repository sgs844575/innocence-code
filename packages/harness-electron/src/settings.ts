// Harness settings v3 — multi-platform provider profiles (Cherry-Studio
// style) with per-model metadata (ModelInfo), persisted by the host. Kept
// free of Electron imports so the runtime stays unit-testable.

import { modelFromPreset, resolvePresetMeta, type ModelInfo } from "./modelPresets";
import { AGENT_IDS, type AgentId } from "./agents";
import type { PluginToggleSource } from "@innocencecode/harness-core";

export type { AgentId } from "./agents";
export type { ModelInfo } from "./modelPresets";
export type { PluginToggleSource } from "@innocencecode/harness-core";

export type ProviderKind = "openai" | "anthropic";
export type PermissionMode = "auto" | "ask" | "plan" | "full";
export type ThemeMode = "system" | "dark" | "light";
/** "" = follow the system locale. */
export type UiLocale = "zh-CN" | "en-US" | "";

export interface ProviderProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  apiKey: string;
  /** Empty = the kind's official default endpoint. */
  baseURL: string;
  enabled: boolean;
  /** User-managed models with metadata (fetched, manual, or preset-enriched). */
  models: ModelInfo[];
  /** True for shipped presets (UI shows them read-only-ish naming). */
  preset?: boolean;
}

export interface HarnessSettings {
  profiles: ProviderProfile[];
  activeProfileId: string; // MOCK_PROFILE_ID or a profile id
  activeModel: string;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  /** UI theme preference; "system" follows nativeTheme. */
  themeMode?: ThemeMode;
  /** Preferred UI language; "" follows the system locale. */
  locale?: UiLocale;
  /** 思考档位（""=跟随模型默认；off/low/medium/high）。 */
  reasoningEffort?: ReasoningEffort;
  /** 当前内置 agent（default/plan/full），决定系统提示词；非法值回落 default。 */
  activeAgent?: AgentId;
  /** 用户级插件开关（四键 subagent/skills/mcp/todo）；缺失键 = 默认开。
   *  项目 .innocence/plugins.yml 优先于此设置（resolvePluginSet 两级覆盖）。 */
  pluginToggles?: PluginToggleSource;
  /** 外部编辑器启动命令（Task 11 工作台入口）；"" = 未配置（入口禁用）。
   *  首个 token 可加引号（含空格的路径）；多余 token 作为前置参数透传。 */
  externalEditorCommand?: string;
}

function normalizeExternalEditorCommand(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

/** 思考档位全集；空串 = 不带参数（跟随模型默认）。max 透传给支持的端点
 *  （GLM 系"最高"），Anthropic 映射最大预算。 */
export type ReasoningEffort = "" | "off" | "low" | "medium" | "high" | "max";

export const REASONING_EFFORTS: ReasoningEffort[] = ["", "off", "low", "medium", "high", "max"];

function normalizeReasoningEffort(raw: unknown): ReasoningEffort {
  return REASONING_EFFORTS.includes(raw as ReasoningEffort) ? (raw as ReasoningEffort) : "";
}

function normalizeActiveAgent(raw: unknown): AgentId {
  return AGENT_IDS.includes(raw as AgentId) ? (raw as AgentId) : "default";
}

/** Built-in offline profile — always available, models: ["mock"]. */
export const MOCK_PROFILE_ID = "__mock__";
export const MOCK_MODEL = "mock";

export interface ProviderPreset {
  name: string;
  kind: ProviderKind;
  baseURL: string;
  models: string[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { name: "OpenAI", kind: "openai", baseURL: "", models: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o"] },
  { name: "Anthropic", kind: "anthropic", baseURL: "", models: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"] },
  { name: "DeepSeek", kind: "openai", baseURL: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-reasoner"] },
  { name: "Gemini", kind: "openai", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { name: "阿里云百炼", kind: "openai", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen3-max", "qwen-max", "qwen-plus", "qwen-turbo"] },
  { name: "智谱开放平台", kind: "openai", baseURL: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-4.6", "glm-4.5", "glm-4.5-air"] },
  { name: "Moonshot", kind: "openai", baseURL: "https://api.moonshot.cn/v1", models: ["kimi-k2-0905-preview", "kimi-k2-turbo-preview"] },
  { name: "xAI", kind: "openai", baseURL: "https://api.x.ai/v1", models: ["grok-4", "grok-4-fast", "grok-3"] },
  { name: "Mistral", kind: "openai", baseURL: "https://api.mistral.ai/v1", models: ["mistral-large-latest", "mistral-small-latest"] },
  { name: "硅基流动", kind: "openai", baseURL: "https://api.siliconflow.cn/v1", models: ["deepseek-ai/DeepSeek-V3.2", "Qwen/Qwen3-235B-A22B"] },
  { name: "OpenRouter", kind: "openai", baseURL: "https://openrouter.ai/api/v1", models: ["openai/gpt-5", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro"] },
  { name: "Ollama 本地", kind: "openai", baseURL: "http://localhost:11434/v1", models: ["qwen3:8b", "llama3.1:8b"] },
];

function presetProfile(preset: ProviderPreset): ProviderProfile {
  return {
    id: `preset_${preset.name}`,
    name: preset.name,
    kind: preset.kind,
    apiKey: "",
    baseURL: preset.baseURL,
    enabled: false,
    models: preset.models.map((m) => modelFromPreset(preset.name, m)),
    preset: true,
  };
}

export const DEFAULT_SETTINGS: HarnessSettings = {
  profiles: PROVIDER_PRESETS.map(presetProfile),
  activeProfileId: MOCK_PROFILE_ID,
  activeModel: MOCK_MODEL,
  workspaceRoot: "",
  permissionMode: "ask",
  themeMode: "system",
  locale: "",
  reasoningEffort: "",
  activeAgent: "default",
  externalEditorCommand: "",
};

let customSeq = 0;
export const newProfileId = () =>
  `custom_${Date.now().toString(36)}_${(customSeq++).toString(36)}`;

export function newCustomProfile(name = "自定义平台"): ProviderProfile {
  return {
    id: newProfileId(),
    name,
    kind: "openai",
    apiKey: "",
    baseURL: "",
    enabled: true,
    models: [],
    preset: false,
  };
}

/** Normalizes one model entry: v2 strings migrate (preset-hit enriches,
 *  anything else is manual), v3 objects keep their fields as-is. */
function normalizeModel(raw: unknown, providerName: string): ModelInfo | null {
  if (typeof raw === "string" && raw.length > 0) {
    // v2 迁移：预设命中记 preset 并 enrich 元数据，否则记 manual（用户自己加过的）。
    const meta = resolvePresetMeta(providerName, raw);
    return meta ? { id: raw, source: "preset", ...meta } : { id: raw, source: "manual" };
  }
  if (typeof raw !== "object" || raw === null) return null;
  const src = raw as Partial<ModelInfo>;
  if (typeof src.id !== "string" || !src.id) return null;
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);
  return {
    id: src.id,
    name: typeof src.name === "string" && src.name ? src.name : undefined,
    group: typeof src.group === "string" && src.group ? src.group : undefined,
    contextWindow: num(src.contextWindow),
    maxInput: num(src.maxInput),
    maxOutput: num(src.maxOutput),
    vision: src.vision === true || undefined,
    tools: src.tools === true || undefined,
    reasoning: src.reasoning === true || undefined,
    streaming: src.streaming === false ? false : undefined,
    source: src.source === "fetch" || src.source === "manual" ? src.source : "preset",
    dirty: src.dirty === true || undefined,
  };
}

function normalizeProfile(raw: unknown): ProviderProfile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const src = raw as Partial<ProviderProfile>;
  if (typeof src.id !== "string" || !src.id) return null;
  return {
    id: src.id,
    name: typeof src.name === "string" && src.name ? src.name : src.id,
    kind: src.kind === "anthropic" ? "anthropic" : "openai",
    apiKey: typeof src.apiKey === "string" ? src.apiKey : "",
    baseURL: typeof src.baseURL === "string" ? src.baseURL : "",
    enabled: src.enabled === true,
    models: Array.isArray(src.models)
      ? src.models
          .map((m) => normalizeModel(m, src.name ?? ""))
          .filter((m): m is ModelInfo => m !== null)
      : [],
    preset: src.preset === true,
  };
}

function normalizeThemeMode(raw: unknown): ThemeMode {
  return raw === "dark" || raw === "light" ? raw : "system";
}

function normalizePermissionMode(raw: unknown): PermissionMode {
  return raw === "auto" || raw === "plan" || raw === "full" ? raw : "ask";
}

function normalizeLocale(raw: unknown): UiLocale {
  return raw === "zh-CN" || raw === "en-US" ? raw : "";
}

const PLUGIN_TOGGLE_KEYS = ["subagent", "skills", "mcp", "todo"] as const;

/** 四键中布尔值保留、非布尔剔除；无有效键回落 undefined（undefined =
 *  默认全开，与 resolvePluginSet 的两级覆盖语义一致）。 */
function normalizePluginToggles(raw: unknown): PluginToggleSource | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const src = raw as Record<string, unknown>;
  const out: PluginToggleSource = {};
  let hasAny = false;
  for (const key of PLUGIN_TOGGLE_KEYS) {
    if (typeof src[key] === "boolean") {
      out[key] = src[key];
      hasAny = true;
    }
  }
  return hasAny ? out : undefined;
}

/** v1 (single-provider) shape, for migration. */
interface SettingsV1 {
  providerId?: string;
  openai?: { apiKey?: string; baseURL?: string; model?: string };
  anthropic?: { apiKey?: string; model?: string };
  workspaceRoot?: string;
  permissionMode?: string;
}

function migrateFromV1(v1: SettingsV1): HarnessSettings {
  const profiles: ProviderProfile[] = [];
  if (v1.openai?.apiKey) {
    profiles.push({
      id: "preset_OpenAI",
      name: "OpenAI",
      kind: "openai",
      apiKey: v1.openai.apiKey,
      baseURL: v1.openai.baseURL ?? "",
      enabled: true,
      models: [modelFromPreset("OpenAI", v1.openai.model ?? "gpt-4o")],
      preset: true,
    });
  }
  if (v1.anthropic?.apiKey) {
    profiles.push({
      id: "preset_Anthropic",
      name: "Anthropic",
      kind: "anthropic",
      apiKey: v1.anthropic.apiKey,
      baseURL: "",
      enabled: true,
      models: [modelFromPreset("Anthropic", v1.anthropic.model ?? "claude-sonnet-4-5")],
      preset: true,
    });
  }
  // Bring in every preset the migration did not cover (deep-copy models).
  for (const preset of PROVIDER_PRESETS) {
    if (!profiles.some((p) => p.name === preset.name)) {
      profiles.push(presetProfile(preset));
    }
  }
  let activeProfileId = MOCK_PROFILE_ID;
  let activeModel = MOCK_MODEL;
  if (v1.providerId === "openai") {
    const p = profiles.find((x) => x.kind === "openai" && x.enabled);
    if (p) {
      activeProfileId = p.id;
      activeModel = p.models[0]?.id ?? MOCK_MODEL;
    }
  } else if (v1.providerId === "anthropic") {
    const p = profiles.find((x) => x.kind === "anthropic" && x.enabled);
    if (p) {
      activeProfileId = p.id;
      activeModel = p.models[0]?.id ?? MOCK_MODEL;
    }
  }
  return {
    profiles,
    activeProfileId,
    activeModel,
    workspaceRoot: typeof v1.workspaceRoot === "string" ? v1.workspaceRoot : "",
    permissionMode: normalizePermissionMode(v1.permissionMode),
    themeMode: normalizeThemeMode((v1 as { themeMode?: unknown }).themeMode),
    locale: normalizeLocale((v1 as { locale?: unknown }).locale),
    reasoningEffort: normalizeReasoningEffort((v1 as { reasoningEffort?: unknown }).reasoningEffort),
    activeAgent: normalizeActiveAgent((v1 as { activeAgent?: unknown }).activeAgent),
    // pluginToggles：v1 不可能含该键，有意不透传（缺省 = 默认全开）。
  };
}

/**
 * Defensive merge/normalize for settings loaded from disk:
 * accepts v2/v3 (profiles[]) — v2 string models migrate to ModelInfo —
 * and migrates v1 (providerId/openai/anthropic).
 */
export function mergeSettings(raw: unknown): HarnessSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS;
  const src = raw as Partial<HarnessSettings> & SettingsV1;
  if (!Array.isArray(src.profiles)) {
    if (src.providerId || src.openai || src.anthropic) return migrateFromV1(src);
    return { ...DEFAULT_SETTINGS, workspaceRoot: src.workspaceRoot ?? "",
      permissionMode: normalizePermissionMode(src.permissionMode),
      themeMode: normalizeThemeMode(src.themeMode), locale: normalizeLocale(src.locale),
      reasoningEffort: normalizeReasoningEffort(src.reasoningEffort),
      activeAgent: normalizeActiveAgent(src.activeAgent),
      pluginToggles: normalizePluginToggles(src.pluginToggles),
      externalEditorCommand: normalizeExternalEditorCommand(src.externalEditorCommand) };
  }

  const profiles = src.profiles
    .map(normalizeProfile)
    .filter((p): p is ProviderProfile => p !== null);
  const active = profiles.find((p) => p.id === src.activeProfileId && p.enabled);
  return {
    profiles,
    activeProfileId: active?.id ?? MOCK_PROFILE_ID,
    activeModel:
      active && typeof src.activeModel === "string" && active.models.some((m) => m.id === src.activeModel)
        ? src.activeModel
        : (active?.models[0]?.id ?? MOCK_MODEL),
    workspaceRoot: typeof src.workspaceRoot === "string" ? src.workspaceRoot : "",
    permissionMode: normalizePermissionMode(src.permissionMode),
    themeMode: normalizeThemeMode(src.themeMode),
    locale: normalizeLocale(src.locale),
    reasoningEffort: normalizeReasoningEffort(src.reasoningEffort),
    activeAgent: normalizeActiveAgent(src.activeAgent),
    pluginToggles: normalizePluginToggles(src.pluginToggles),
    externalEditorCommand: normalizeExternalEditorCommand(src.externalEditorCommand),
  };
}

export type ActiveResolution =
  | { kind: "mock" }
  | { kind: ProviderKind; apiKey: string; baseURL: string; model: string };

/** Resolves the currently selected provider+model, falling back to mock. */
export function resolveActive(settings: HarnessSettings): ActiveResolution {
  const profile = settings.profiles.find(
    (p) => p.id === settings.activeProfileId && p.enabled,
  );
  if (!profile || !profile.models.some((m) => m.id === settings.activeModel)) {
    return { kind: "mock" };
  }
  return {
    kind: profile.kind,
    apiKey: profile.apiKey,
    baseURL: profile.baseURL,
    model: settings.activeModel,
  };
}

/** Fetches a platform's model id list from its /models endpoint. */
export async function listModels(
  profile: Pick<ProviderProfile, "kind" | "apiKey" | "baseURL">,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const { kind, apiKey, baseURL } = profile;
  const base = (
    baseURL || (kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1")
  ).replace(/\/+$/, "");
  const url = kind === "anthropic" ? `${base}/v1/models` : `${base}/models`;
  const headers: Record<string, string> =
    kind === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${apiKey}` };
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`获取模型列表失败 HTTP ${res.status}：${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    data?: Array<{ id?: string; name?: string; display_name?: string }>;
  };
  const ids = (json.data ?? [])
    .map((m) => m.id ?? m.name)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)];
}

export const MOCK_GREETING =
  "当前是本地 Mock 模型（未配置真实 API）。我只会原样回复，不会调用工具。\n\n" +
  "在设置（左下角齿轮）里选择一个平台、填入 API Key、选择模型后，我才能真正干活。";
