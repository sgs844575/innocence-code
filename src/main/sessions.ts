// Session store facade: owns the in-memory session table (order + records)
// and assembles the three responsibilities behind the stable exports —
// sessionIndexStore.ts (index I/O), sessionHydration.ts (lazy transcript
// hydration incl. corrupt-transcript self-heal), sessionMessages.ts (message
// mutation). The module stays electron-free so vitest can exercise it
// directly; initSessionStore(dir) runs once from the main entry.
import fs from "node:fs";
import {
  loadSessionIndex,
  persistSessionIndex,
  publicSessionView,
  sessionIndexEntryOf,
  sessionIndexFile,
  sessionRecordFromEntry,
  sessionTranscriptFile,
  type SessionRecord,
} from "./sessionIndexStore";
import { hydrateSessionMessages } from "./sessionHydration";
import { appendSessionMessage, updateSessionMessage } from "./sessionMessages";
import type { ChatMessage, Session } from "../shared/ipc";

export type { SessionRecord } from "./sessionIndexStore";

const sessions = new Map<string, SessionRecord>();
// Newest first when listing, mirroring a typical chat sidebar.
const order: string[] = [];
let storeDir: string | null = null;

function persistIndex(): void {
  persistSessionIndex(
    sessionIndexFile(storeDir),
    order.map((id) => sessionIndexEntryOf(sessions.get(id)!)),
  );
}

function hydrate(record: SessionRecord): void {
  hydrateSessionMessages(record, {
    transcriptFile: sessionTranscriptFile(storeDir, record.id),
    persistIndex,
  });
}

/** Loads the persisted index; call once at app start (idempotent, for tests). */
export function initSessionStore(userDataDir: string): void {
  storeDir = userDataDir;
  sessions.clear();
  order.length = 0;
  for (const e of loadSessionIndex(sessionIndexFile(storeDir))) {
    if (!e || typeof e.id !== "string") continue;
    sessions.set(e.id, sessionRecordFromEntry(e));
    order.push(e.id);
  }
}

export function listSessions(): Session[] {
  return order.map((id) => publicSessionView(sessions.get(id)!));
}

export function createSession(options?: { title?: string; workspaceRoot?: string }): Session {
  const id = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const record: SessionRecord = {
    id,
    title: options?.title?.trim() || "新会话",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    workspaceRoot: options?.workspaceRoot ?? "",
    messages: [],
    messagesLoaded: true, // Fresh session: nothing on disk to restore.
  };
  sessions.set(id, record);
  order.unshift(id);
  persistIndex();
  return publicSessionView(record);
}

export function deleteSession(id: string): void {
  sessions.delete(id);
  const idx = order.indexOf(id);
  if (idx >= 0) order.splice(idx, 1);
  persistIndex();
  const file = sessionTranscriptFile(storeDir, id);
  if (file) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Transcript removal is best-effort; the session itself is gone.
    }
  }
}

export function getSession(id: string): SessionRecord | undefined {
  return sessions.get(id);
}

export function listMessages(id: string): ChatMessage[] {
  const record = sessions.get(id);
  if (!record) return [];
  if (!record.messagesLoaded) hydrate(record);
  return record.messages;
}

export function appendMessage(id: string, message: ChatMessage): void {
  const record = sessions.get(id);
  if (!record) return;
  if (!record.messagesLoaded) hydrate(record);
  appendSessionMessage(record, message);
  const idx = order.indexOf(id);
  if (idx > 0) {
    order.splice(idx, 1);
    order.unshift(id);
  }
  persistIndex();
}

export function updateMessage(
  sessionId: string,
  messageId: string,
  patch: Partial<ChatMessage> | ((message: ChatMessage) => void),
): void {
  const record = sessions.get(sessionId);
  if (!record) return;
  updateSessionMessage(record, messageId, patch);
}
