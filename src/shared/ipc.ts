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
export type PermissionMode = "auto" | "ask" | "plan";

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
  streaming?: boolean;
  source: ModelSource;
  /** 用户手改保护：enrich 不覆盖已 dirty 模型的任何字段。 */
  dirty?: boolean;
}

export interface ChatPermissionEvent {
  sessionId: string;
  messageId: string;
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
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
}

export interface InnocenceCodeApi {
  getAppInfo(): Promise<AppInfo>;
  getTheme(): Promise<{ mode: ThemeMode; resolved: ResolvedTheme }>;
  setTheme(mode: ThemeMode): Promise<void>;
  onThemeChanged(cb: (mode: ThemeMode, resolved: ResolvedTheme) => void): () => void;
  listSessions(): Promise<Session[]>;
  createSession(title?: string): Promise<Session>;
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
  onMenuNewSession(cb: () => void): () => void;
  popupMenu(id: MenuId): Promise<void>;
}
