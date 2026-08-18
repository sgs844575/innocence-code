// Harness settings v2 — multi-platform provider profiles (Cherry-Studio
// style), persisted by the host. Kept free of Electron imports so the
// runtime stays unit-testable.

export type ProviderKind = "openai" | "anthropic";
export type PermissionMode = "auto" | "ask" | "plan";

export interface ProviderProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  apiKey: string;
  /** Empty = the kind's official default endpoint. */
  baseURL: string;
  enabled: boolean;
  /** User-managed model id list (fetched from /models or added manually). */
  models: string[];
  /** True for shipped presets (UI shows them read-only-ish naming). */
  preset?: boolean;
}

export interface HarnessSettings {
  profiles: ProviderProfile[];
  activeProfileId: string; // MOCK_PROFILE_ID or a profile id
  activeModel: string;
  workspaceRoot: string;
  permissionMode: PermissionMode;
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
  { name: "OpenAI", kind: "openai", baseURL: "", models: ["gpt-4o", "gpt-4o-mini"] },
  { name: "Anthropic", kind: "anthropic", baseURL: "", models: ["claude-sonnet-4-5", "claude-opus-4-1"] },
  { name: "DeepSeek", kind: "openai", baseURL: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-reasoner"] },
  { name: "硅基流动", kind: "openai", baseURL: "https://api.siliconflow.cn/v1", models: ["deepseek-ai/DeepSeek-V3.2", "Qwen/Qwen3-32B"] },
  { name: "OpenRouter", kind: "openai", baseURL: "https://openrouter.ai/api/v1", models: ["openai/gpt-4o", "anthropic/claude-sonnet-4"] },
  { name: "智谱开放平台", kind: "openai", baseURL: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-4-plus", "glm-4-flash"] },
  { name: "Moonshot", kind: "openai", baseURL: "https://api.moonshot.cn/v1", models: ["kimi-k2-0905-preview", "moonshot-v1-32k"] },
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
    models: [...preset.models],
    preset: true,
  };
}

export const DEFAULT_SETTINGS: HarnessSettings = {
  profiles: PROVIDER_PRESETS.map(presetProfile),
  activeProfileId: MOCK_PROFILE_ID,
  activeModel: MOCK_MODEL,
  workspaceRoot: "",
  permissionMode: "ask",
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
      ? src.models.filter((m): m is string => typeof m === "string" && m.length > 0)
      : [],
    preset: src.preset === true,
  };
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
      models: [v1.openai.model ?? "gpt-4o"],
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
      models: [v1.anthropic.model ?? "claude-sonnet-4-5"],
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
      activeModel = p.models[0] ?? MOCK_MODEL;
    }
  } else if (v1.providerId === "anthropic") {
    const p = profiles.find((x) => x.kind === "anthropic" && x.enabled);
    if (p) {
      activeProfileId = p.id;
      activeModel = p.models[0] ?? MOCK_MODEL;
    }
  }
  return {
    profiles,
    activeProfileId,
    activeModel,
    workspaceRoot: typeof v1.workspaceRoot === "string" ? v1.workspaceRoot : "",
    permissionMode:
      v1.permissionMode === "auto" || v1.permissionMode === "plan" ? v1.permissionMode : "ask",
  };
}

/**
 * Defensive merge/normalize for settings loaded from disk:
 * accepts v2 (profiles[]) and migrates v1 (providerId/openai/anthropic).
 */
export function mergeSettings(raw: unknown): HarnessSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS;
  const src = raw as Partial<HarnessSettings> & SettingsV1;
  if (!Array.isArray(src.profiles)) {
    if (src.providerId || src.openai || src.anthropic) return migrateFromV1(src);
    return { ...DEFAULT_SETTINGS, workspaceRoot: src.workspaceRoot ?? "", permissionMode:
      src.permissionMode === "auto" || src.permissionMode === "plan" ? src.permissionMode : "ask" };
  }

  const profiles = src.profiles
    .map(normalizeProfile)
    .filter((p): p is ProviderProfile => p !== null);
  const active = profiles.find((p) => p.id === src.activeProfileId && p.enabled);
  return {
    profiles,
    activeProfileId: active?.id ?? MOCK_PROFILE_ID,
    activeModel:
      active && typeof src.activeModel === "string" && active.models.includes(src.activeModel)
        ? src.activeModel
        : (active?.models[0] ?? MOCK_MODEL),
    workspaceRoot: typeof src.workspaceRoot === "string" ? src.workspaceRoot : "",
    permissionMode:
      src.permissionMode === "auto" || src.permissionMode === "plan"
        ? src.permissionMode
        : "ask",
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
  if (!profile || !profile.models.includes(settings.activeModel)) {
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

export const DEFAULT_SYSTEM_PROMPT =
  "你是 InnocenceCode 的编程助手。你可以调用工具读写工作区文件。\n" +
  "约定：引用代码位置用 `文件路径:行号`；修改文件前先 Read 确认原文；" +
  "工具失败时读取错误信息自行纠正，不要重复同样的失败调用；" +
  "回答用用户的语言，简洁直接。";

export const MOCK_GREETING =
  "当前是本地 Mock 模型（未配置真实 API）。我只会原样回复，不会调用工具。\n\n" +
  "在设置（左下角齿轮）里选择一个平台、填入 API Key、选择模型后，我才能真正干活。";
