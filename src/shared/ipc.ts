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
  onMenuNewSession(cb: () => void): () => void;
  popupMenu(id: MenuId): Promise<void>;
}
