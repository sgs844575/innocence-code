// Harness settings as persisted by the host (main process settings store).
// Kept free of Electron imports so the runtime stays unit-testable.

export type ProviderKind = "mock" | "openai" | "anthropic";
export type PermissionMode = "auto" | "ask" | "plan";

export interface HarnessSettings {
  providerId: ProviderKind;
  openai: {
    apiKey: string;
    baseURL: string; // empty = official endpoint
    model: string;
  };
  anthropic: {
    apiKey: string;
    model: string;
  };
  /** Empty = no workspace; fs/shell tools will refuse until one is picked. */
  workspaceRoot: string;
  permissionMode: PermissionMode;
}

export const DEFAULT_SETTINGS: HarnessSettings = {
  providerId: "mock",
  openai: { apiKey: "", baseURL: "", model: "gpt-4o" },
  anthropic: { apiKey: "", model: "claude-sonnet-4-5" },
  workspaceRoot: "",
  permissionMode: "ask",
};

/** Defensive merge for settings loaded from disk (partial/legacy tolerant). */
export function mergeSettings(raw: unknown): HarnessSettings {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<HarnessSettings>;
  return {
    providerId:
      src.providerId === "openai" || src.providerId === "anthropic" ? src.providerId : "mock",
    openai: { ...DEFAULT_SETTINGS.openai, ...(src.openai ?? {}) },
    anthropic: { ...DEFAULT_SETTINGS.anthropic, ...(src.anthropic ?? {}) },
    workspaceRoot: typeof src.workspaceRoot === "string" ? src.workspaceRoot : "",
    permissionMode:
      src.permissionMode === "auto" || src.permissionMode === "plan" ? src.permissionMode : "ask",
  };
}

export const DEFAULT_SYSTEM_PROMPT =
  "你是 InnocenceCode 的编程助手。你可以调用工具读写工作区文件。\n" +
  "约定：引用代码位置用 `文件路径:行号`；修改文件前先 Read 确认原文；" +
  "工具失败时读取错误信息自行纠正，不要重复同样的失败调用；" +
  "回答用用户的语言，简洁直接。";

export const MOCK_GREETING =
  "当前是本地 Mock 模型（未配置真实 API）。我只会原样回复，不会调用工具。\n\n" +
  "要在设置里选择 OpenAI 或 Anthropic 并填入 API key 之后，我才能真正干活。";
