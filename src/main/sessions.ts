// In-memory session store (swap for SQLite later); keeps the same IPC surface.
import type { ChatMessage, Session } from "../shared/ipc";

interface SessionRecord extends Session {
  messages: ChatMessage[];
}

const sessions = new Map<string, SessionRecord>();
// Newest first when listing, mirroring a typical chat sidebar.
const order: string[] = [];

function publicView(record: SessionRecord): Session {
  const { messages, ...rest } = record;
  return { ...rest, messageCount: messages.length };
}

export function listSessions(): Session[] {
  return order.map((id) => publicView(sessions.get(id)!));
}

export function createSession(title?: string): Session {
  const id = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const record: SessionRecord = {
    id,
    title: title?.trim() || "新会话",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    messages: [],
  };
  sessions.set(id, record);
  order.unshift(id);
  return publicView(record);
}

export function deleteSession(id: string): void {
  sessions.delete(id);
  const idx = order.indexOf(id);
  if (idx >= 0) order.splice(idx, 1);
}

export function getSession(id: string): SessionRecord | undefined {
  return sessions.get(id);
}

export function listMessages(id: string): ChatMessage[] {
  return sessions.get(id)?.messages ?? [];
}

export function appendMessage(id: string, message: ChatMessage): void {
  const record = sessions.get(id);
  if (!record) return;
  record.messages.push(message);
  record.updatedAt = Date.now();
  // Retitle the session from the first user message, like most chat clients.
  if (record.title === "新会话" && message.role === "user") {
    record.title = message.content.split("\n")[0].slice(0, 24) || "新会话";
  }
  const idx = order.indexOf(id);
  if (idx > 0) {
    order.splice(idx, 1);
    order.unshift(id);
  }
}

export function updateMessage(
  sessionId: string,
  messageId: string,
  patch: Partial<ChatMessage> | ((message: ChatMessage) => void),
): void {
  const message = sessions.get(sessionId)?.messages.find((m) => m.id === messageId);
  if (!message) return;
  if (typeof patch === "function") patch(message);
  else Object.assign(message, patch);
}
