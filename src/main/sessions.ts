// Session store: in-memory index persisted to <userData>/sessions.json after
// every mutation; message bodies are hydrated lazily from the JSONL
// transcripts the harness runtime writes to <userData>/transcripts/.
// initSessionStore(dir) runs once from the main entry; tests inject a temp
// dir. The module stays electron-free so vitest can exercise it directly.
import fs from "node:fs";
import path from "node:path";
import { messageText, type ChatMessage, type MessagePart, type Session } from "../shared/ipc";

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
  /** 会话绑定的项目根；旧索引缺省为空串。 */
  workspaceRoot?: string;
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
      workspaceRoot: r.workspaceRoot,
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
      workspaceRoot: typeof e.workspaceRoot === "string" ? e.workspaceRoot : "",
      messages: [],
      messagesLoaded: false,
    });
    order.push(e.id);
  }
}

/** Defensive mapping of one untyped transcript part onto the shared
 *  MessagePart union; anything malformed or unknown maps to null and is
 *  dropped. Tool and thinking parts survive hydration so restored
 *  transcripts match the live stream's structured view. */
function toMessagePart(p: unknown): MessagePart | null {
  if (typeof p !== "object" || p === null) return null;
  const t = (p as { type?: unknown }).type;
  if (t === "text" && typeof (p as { text?: unknown }).text === "string")
    return { type: "text", text: (p as { text: string }).text };
  if (t === "thinking" && typeof (p as { text?: unknown }).text === "string")
    return { type: "thinking", text: (p as { text: string }).text };
  if (t === "toolCall")
    return {
      type: "toolCall",
      id: String((p as { id?: unknown }).id ?? ""),
      toolName: String((p as { toolName?: unknown }).toolName ?? ""),
      args: ((p as { args?: unknown }).args ?? {}) as Record<string, unknown>,
    };
  if (t === "toolResult")
    return {
      type: "toolResult",
      toolCallId: String((p as { toolCallId?: unknown }).toolCallId ?? ""),
      content: String((p as { content?: unknown }).content ?? ""),
      isError: (p as { isError?: unknown }).isError === true,
    };
  return null;
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
  // Each line appends one turn whose history is the full conversation so far.
  // 取"最全的快照"而非盲取最后一行：重启后 runtime 若曾以空历史发言，最后
  // 一行会是只含那一轮的短快照（写侧已修，读侧兜底救回旧行里的完整历史）。
  let history: unknown[] | null = null;
  let at = record.createdAt;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as TranscriptTurn;
      if (Array.isArray(rec.history) && (history === null || rec.history.length >= history.length)) {
        history = rec.history;
        const parsed = Date.parse(typeof rec.at === "string" ? rec.at : "");
        if (!Number.isNaN(parsed)) at = parsed;
      }
    } catch {
      // Skip a torn line rather than dropping the whole transcript.
    }
  }
  if (!history) {
    // 空文件 = 从未聊过；有内容但一行都解不开 = 损坏（如断电后的全 NUL 文件：
    // 目录项还在、数据块清零）。把坏文件移开自愈，注入一条可见告知——不能让
    // 侧栏有会话、聊天页却静默空白。
    if (raw.trim().length === 0) return;
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // 移不开就原地保留，下次仍走告知路径。
    }
    record.messages = [
      {
        id: "msg_corrupt_notice",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "> ⚠️ 会话记录损坏（上次写入中断），历史消息无法恢复；已将损坏的记录文件移开，继续对话不受影响。",
          },
        ],
        createdAt: at,
      },
    ];
    record.messageCount = record.messages.length;
    return;
  }
  const messages: ChatMessage[] = [];
  for (const m of history) {
    const role = (m as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") continue;
    // Keep every valid part (text/thinking/toolCall/toolResult) so restored
    // transcripts match the live structured stream; rows with no valid parts
    // at all (empty text + empty tool) produce no message.
    const mapped = (
      Array.isArray((m as { parts?: unknown }).parts)
        ? ((m as { parts?: unknown[] }).parts ?? []).map(toMessagePart)
        : []
    ).filter((x): x is MessagePart => x !== null);
    if (mapped.length === 0) continue;
    // Tool results are persisted as their own textless user turn (harness-core
    // loop.ts pushes { role: "user", parts: resultParts }), while the live
    // stream appends them to the assistant message — the shape pairTools
    // expects. Merge such turns into the preceding assistant message; only a
    // textless user turn with no assistant predecessor stays standalone.
    if (role === "user" && !mapped.some((p) => p.type === "text")) {
      const prev = messages[messages.length - 1];
      if (prev?.role === "assistant") {
        prev.parts.push(...mapped);
        continue;
      }
    }
    messages.push({
      id: `msg_restored_${messages.length}`,
      role,
      parts: mapped,
      createdAt: at,
    });
  }
  // 一轮 = 一条助手消息（对齐 live 形状）：transcript 里每个工具轮是独立的
  // assistant 消息（中间夹 user 工具结果轮，上一步已并入），这里把连续的
  // assistant 消息归并成一条——否则重载后一轮对话会被拆成多个气泡。
  // 真实用户消息（含 text）天然分隔轮次，不会跨轮误并。
  const coalesced: ChatMessage[] = [];
  for (const m of messages) {
    const prev = coalesced[coalesced.length - 1];
    if (m.role === "assistant" && prev?.role === "assistant") {
      prev.parts.push(...m.parts);
    } else {
      coalesced.push(m);
    }
  }
  record.messages = coalesced;
  record.messageCount = coalesced.length;
}

export function listSessions(): Session[] {
  return order.map((id) => publicView(sessions.get(id)!));
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
    record.title = messageText(message.parts).split("\n")[0].slice(0, 24) || "新会话";
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
