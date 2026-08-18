// Session store: in-memory index persisted to <userData>/sessions.json after
// every mutation; message bodies are hydrated lazily from the JSONL
// transcripts the harness runtime writes to <userData>/transcripts/.
// initSessionStore(dir) runs once from the main entry; tests inject a temp
// dir. The module stays electron-free so vitest can exercise it directly.
import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, Session } from "../shared/ipc";

interface SessionRecord extends Session {
  messages: ChatMessage[];
  /** False for index-restored sessions until their transcript has been read. */
  messagesLoaded: boolean;
}

interface SessionIndexEntry {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** Shape of one transcript line written by HarnessRuntime.persist. */
interface TranscriptTurn {
  at?: unknown;
  history?: unknown;
}

const sessions = new Map<string, SessionRecord>();
// Newest first when listing, mirroring a typical chat sidebar.
const order: string[] = [];
let storeDir: string | null = null;

function indexFile(): string | null {
  return storeDir ? path.join(storeDir, "sessions.json") : null;
}

function transcriptFile(id: string): string | null {
  return storeDir ? path.join(storeDir, "transcripts", `${id}.jsonl`) : null;
}

function publicView(record: SessionRecord): Session {
  const { messages, messagesLoaded, ...rest } = record;
  return { ...rest };
}

/** Atomic index rewrite (tmp + rename); best-effort, never breaks a chat turn. */
function persistIndex(): void {
  const file = indexFile();
  if (!file) return;
  const entries: SessionIndexEntry[] = order.map((id) => {
    const r = sessions.get(id)!;
    return {
      id: r.id,
      title: r.title,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      messageCount: r.messageCount,
    };
  });
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch {
    // Losing the index write must not fail the mutation itself.
  }
}

/** Loads the persisted index; call once at app start (idempotent, for tests). */
export function initSessionStore(userDataDir: string): void {
  storeDir = userDataDir;
  sessions.clear();
  order.length = 0;
  const file = indexFile();
  if (!file) return;
  let entries: SessionIndexEntry[];
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8")) as SessionIndexEntry[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Corrupt index: move it aside instead of crashing at boot.
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        // Nothing sensible left to do — start empty.
      }
    }
    return;
  }
  if (!Array.isArray(entries)) return;
  for (const e of entries) {
    if (!e || typeof e.id !== "string") continue;
    sessions.set(e.id, {
      id: e.id,
      title: typeof e.title === "string" ? e.title : "新会话",
      createdAt: typeof e.createdAt === "number" ? e.createdAt : Date.now(),
      updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : Date.now(),
      messageCount: typeof e.messageCount === "number" ? e.messageCount : 0,
      messages: [],
      messagesLoaded: false,
    });
    order.push(e.id);
  }
}

function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter(
      (p): p is { type: "text"; text: string } =>
        Boolean(p) &&
        (p as { type?: unknown }).type === "text" &&
        typeof (p as { text?: unknown }).text === "string",
    )
    .map((p) => p.text)
    .join("");
}

/** Restores message bodies from the session's JSONL transcript, if any. */
function hydrate(record: SessionRecord): void {
  record.messagesLoaded = true;
  const file = transcriptFile(record.id);
  if (!file) return;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // No transcript yet (created but never chatted in).
  }
  // Each line appends one turn whose history is the full conversation so far,
  // so the last parseable line carries everything.
  let history: unknown[] | null = null;
  let at = record.createdAt;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as TranscriptTurn;
      if (Array.isArray(rec.history)) {
        history = rec.history;
        const parsed = Date.parse(typeof rec.at === "string" ? rec.at : "");
        if (!Number.isNaN(parsed)) at = parsed;
      }
    } catch {
      // Skip a torn line rather than dropping the whole transcript.
    }
  }
  if (!history) return;
  const messages: ChatMessage[] = [];
  for (const m of history) {
    const role = (m as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") continue;
    // Text parts only: tool-call/result parts stay out of the chat view
    // (live streams render them as blockquote markers, not messages).
    const content = extractText((m as { parts?: unknown }).parts);
    if (!content.trim()) continue;
    messages.push({
      id: `msg_restored_${messages.length}`,
      role,
      content,
      createdAt: at,
    });
  }
  record.messages = messages;
  record.messageCount = messages.length;
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
    messagesLoaded: true, // Fresh session: nothing on disk to restore.
  };
  sessions.set(id, record);
  order.unshift(id);
  persistIndex();
  return publicView(record);
}

export function deleteSession(id: string): void {
  sessions.delete(id);
  const idx = order.indexOf(id);
  if (idx >= 0) order.splice(idx, 1);
  persistIndex();
  const file = transcriptFile(id);
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
  record.messages.push(message);
  record.messageCount = record.messages.length;
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
  persistIndex();
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
