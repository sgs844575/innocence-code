// Shared IPC contract — imported by both main and preload (bundled into each)
// so both processes rely on the same channel names and types.

export const IPC = {
  appInfo: "app:info",
  themeGet: "theme:get",
  themeSet: "theme:set",
  themeChanged: "theme:changed",
  uiNewSession: "ui:new-session",
  menuPopup: "menu:popup",
  sessionsList: "sessions:list",
  sessionCreate: "session:create",
  sessionDelete: "session:delete",
  sessionsChanged: "sessions:changed",
  messagesList: "messages:list",
  chatSend: "chat:send",
  chatStop: "chat:stop",
  chatDelta: "chat:delta",
  chatDone: "chat:done",
  chatError: "chat:error",
  // Harness additions (M3) — additive only, existing channels untouched.
  chatPermission: "chat:permission",
  chatPermissionRespond: "chat:permission-respond",
  chatTool: "chat:tool",
  chatThinking: "chat:thinking",
  workspacePick: "workspace:pick",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  settingsModelsList: "settings:models-list",
  settingsEnrichModels: "settings:enrich-models",
} as const;

export type ThemeMode = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";
export type MenuId = "file" | "edit" | "view" | "help";

export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  locale: string;
}

export interface TextPart { type: "text"; text: string }
export interface ThinkingPart { type: "thinking"; text: string }
export interface ToolCallPart {
  type: "toolCall";
  id: string;
  toolName: string;
  args: Record<string, unknown>;
}
export interface ToolResultPart {
  type: "toolResult";
  toolCallId: string;
  content: string;
  isError: boolean;
  durationMs?: number;
}
export type MessagePart = TextPart | ThinkingPart | ToolCallPart | ToolResultPart;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  createdAt: number;
  streaming?: boolean;
}

/** 所有 text part 的拼接（标题、引用、纯文本场景）。 */
export function messageText(parts: MessagePart[]): string {
  return parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** 不可变地把 delta 追加到末尾 text part（React state 更新用）。 */
export function appendText(parts: MessagePart[], delta: string): MessagePart[] {
  if (!delta) return parts;
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    const next = [...parts];
    next[next.length - 1] = { type: "text", text: last.text + delta };
    return next;
  }
  return [...parts, { type: "text", text: delta }];
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** 会话绑定的项目根目录；空串 = 不在项目中。侧边栏按它分组。 */
  workspaceRoot?: string;
}

export interface ChatDeltaEvent {
  sessionId: string;
  messageId: string;
  delta: string;
}

export interface ChatDoneEvent {
  sessionId: string;
  messageId: string;
}

export interface ChatErrorEvent {
  sessionId: string;
  messageId: string;
  error: string;
}

export interface ChatToolEvent {
  sessionId: string;
  messageId: string;
  part: ToolCallPart | ToolResultPart;
}
export interface ChatThinkingEvent {
  sessionId: string;
  messageId: string;
  delta: string;
}

// ---- Harness contract (M3+) -------------------------------------------------

export type PermissionChoice = "allow" | "allowSession" | "deny";
export type ProviderKind = "openai" | "anthropic";
export type PermissionMode = "auto" | "ask" | "plan" | "full";

// 镜像契约：以下两个类型复制自 packages/harness-electron/src/modelPresets.ts
// （shared 不 import 包），修改任何一侧时必须同步另一侧。
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

// 镜像契约：以下资源类型镜像 packages/harness-core/src/policy.ts 的
// PermissionResource（shared 不 import 包），修改任何一侧时必须同步另一侧
// （packages/harness-electron/tests/mirror.test.ts 有 drift-guard）。
/** 脱敏持久化资源：工具调用作用的对象摘要，raw 值永不进入。 */
export interface PermissionResourceInfo {
  /** 资源类别（file/process/url/skill…）。 */
  kind: string;
  /** 资源上的动作（read/write/execute…）。 */
  action: string;
  /** 稳定作用域（工作区相对路径、命令摘要、脱敏 URL…）。 */
  scope: string;
  /** 后续 schema 脱敏预留的附加元数据（P2/P3）。 */
  metadata?: Record<string, unknown>;
}

export interface ChatPermissionEvent {
  sessionId: string;
  messageId: string;
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** 本次调用作用的脱敏资源摘要（来自持久化的 PermissionRequest）。 */
  resource: PermissionResourceInfo;
}

/** One configured platform (preset or custom). */
export interface ProviderProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  apiKey: string;
  baseURL: string;
  enabled: boolean;
  models: ModelInfo[];
  preset?: boolean;
}

export interface HarnessSettings {
  profiles: ProviderProfile[];
  activeProfileId: string;
  activeModel: string;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  /** UI theme preference; "system" follows nativeTheme. */
  themeMode?: ThemeMode;
  /** Preferred UI language; "" follows the system locale. */
  locale?: "zh-CN" | "en-US" | "";
  /** 思考档位（""=跟随模型默认；off/low/medium/high/max）。与 harness-electron 同步。 */
  reasoningEffort?: "" | "off" | "low" | "medium" | "high" | "max";
}

/** AddProviderDialog 的预设选项（PROVIDER_PRESET_MIRROR 的条目形状）。 */
export interface ProviderPresetMirror {
  name: string;
  kind: ProviderKind;
  baseURL: string;
  models: string[];
}

// 镜像契约：与 harness-electron settings.ts 的同名常量保持一致（shared 不
// import 包），渲染层从这里取，避免各组件散落 "__mock__"/"mock" 魔法串。
// 修改任何一侧时必须同步另一侧（tests/mirror.test.ts 有 drift-guard）。
export const MOCK_PROFILE_ID = "__mock__";
export const MOCK_MODEL = "mock";

// 与 harness-electron PROVIDER_PRESETS（packages/harness-electron/src/settings.ts）
// 同步的轻量镜像：渲染层无法 import node 侧包，添加厂家对话框的预设列表与
// 默认值从这里取。修改任何一侧时必须同步另一侧。
export const PROVIDER_PRESET_MIRROR: ProviderPresetMirror[] = [
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

export interface InnocenceCodeApi {
  getAppInfo(): Promise<AppInfo>;
  getTheme(): Promise<{ mode: ThemeMode; resolved: ResolvedTheme }>;
  setTheme(mode: ThemeMode): Promise<void>;
  onThemeChanged(cb: (mode: ThemeMode, resolved: ResolvedTheme) => void): () => void;
  listSessions(): Promise<Session[]>;
  createSession(options?: { title?: string; workspaceRoot?: string }): Promise<Session>;
  deleteSession(id: string): Promise<void>;
  /** Fired after every session-store mutation (create/delete/append/retitle). */
  onSessionsChanged(cb: (list: Session[]) => void): () => void;
  listMessages(sessionId: string): Promise<ChatMessage[]>;
  sendMessage(sessionId: string, text: string): Promise<{ messageId: string }>;
  stopMessage(sessionId: string, messageId: string): Promise<void>;
  onChatDelta(cb: (e: ChatDeltaEvent) => void): () => void;
  onChatDone(cb: (e: ChatDoneEvent) => void): () => void;
  onChatError(cb: (e: ChatErrorEvent) => void): () => void;
  onChatTool(cb: (e: ChatToolEvent) => void): () => void;
  onChatThinking(cb: (e: ChatThinkingEvent) => void): () => void;
  onChatPermission(cb: (e: ChatPermissionEvent) => void): () => void;
  respondChatPermission(requestId: string, choice: PermissionChoice): Promise<void>;
  pickWorkspace(): Promise<string>;
  getHarnessSettings(): Promise<HarnessSettings>;
  setHarnessSettings(settings: HarnessSettings): Promise<void>;
  listProviderModels(profileId: string): Promise<string[]>;
  /** 用 harness-electron 预设目录补全模型元数据（main 侧 modelFromPreset）。 */
  enrichModels(providerName: string, ids: string[]): Promise<ModelInfo[]>;
  onMenuNewSession(cb: () => void): () => void;
  popupMenu(id: MenuId): Promise<void>;
}
