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
  messagesList: "messages:list",
  chatSend: "chat:send",
  chatStop: "chat:stop",
  chatDelta: "chat:delta",
  chatDone: "chat:done",
  chatError: "chat:error",
  // Harness additions (M3) — additive only, existing channels untouched.
  chatPermission: "chat:permission",
  chatPermissionRespond: "chat:permission-respond",
  workspacePick: "workspace:pick",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
} as const;

export type ThemeMode = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";
export type MenuId = "file" | "edit" | "view" | "help";

export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  locale: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  streaming?: boolean;
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

// ---- Harness contract (M3) --------------------------------------------------

export type PermissionChoice = "allow" | "allowSession" | "deny";
export type ProviderKind = "mock" | "openai" | "anthropic";
export type PermissionMode = "auto" | "ask" | "plan";

export interface ChatPermissionEvent {
  sessionId: string;
  messageId: string;
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface HarnessSettings {
  providerId: ProviderKind;
  openai: { apiKey: string; baseURL: string; model: string };
  anthropic: { apiKey: string; model: string };
  workspaceRoot: string;
  permissionMode: PermissionMode;
}

export interface InnocenceCodeApi {
  getAppInfo(): Promise<AppInfo>;
  getTheme(): Promise<{ mode: ThemeMode; resolved: ResolvedTheme }>;
  setTheme(mode: ThemeMode): Promise<void>;
  onThemeChanged(cb: (mode: ThemeMode, resolved: ResolvedTheme) => void): () => void;
  listSessions(): Promise<Session[]>;
  createSession(title?: string): Promise<Session>;
  deleteSession(id: string): Promise<void>;
  listMessages(sessionId: string): Promise<ChatMessage[]>;
  sendMessage(sessionId: string, text: string): Promise<{ messageId: string }>;
  stopMessage(sessionId: string, messageId: string): Promise<void>;
  onChatDelta(cb: (e: ChatDeltaEvent) => void): () => void;
  onChatDone(cb: (e: ChatDoneEvent) => void): () => void;
  onChatError(cb: (e: ChatErrorEvent) => void): () => void;
  onChatPermission(cb: (e: ChatPermissionEvent) => void): () => void;
  respondChatPermission(requestId: string, choice: PermissionChoice): Promise<void>;
  pickWorkspace(): Promise<string>;
  getHarnessSettings(): Promise<HarnessSettings>;
  setHarnessSettings(settings: HarnessSettings): Promise<void>;
  onMenuNewSession(cb: () => void): () => void;
  popupMenu(id: MenuId): Promise<void>;
}
