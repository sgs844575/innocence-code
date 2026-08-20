// Transcript hydration responsibility of the session facade: restores message
// bodies from a session's JSONL transcript into its record — including the
// corrupt-transcript self-heal (NUL-filled files move aside with a visible
// notice), tool-result merging into the preceding assistant message and the
// per-turn assistant coalescing that keeps reloaded rounds as one bubble.
// Pure record transformation: file placement and index persistence are
// injected so the module stays free of store wiring.
import fs from "node:fs";
import { decodeTranscript } from "@innocencecode/harness-electron";
import type { SessionRecord } from "./sessionIndexStore";
import type { ChatMessage, MessagePart } from "../shared/ipc";

export interface HydrateOptions {
  /** Transcript path for this session; null = no persistence dir (empty store). */
  transcriptFile: string | null;
  /** Persists the index (called when hydration repairs the stored count). */
  persistIndex(): void;
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
export function hydrateSessionMessages(record: SessionRecord, options: HydrateOptions): void {
  record.messagesLoaded = true;
  const indexedMessageCount = record.messageCount;
  const file = options.transcriptFile;
  if (!file) return;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // No transcript yet (created but never chatted in).
  }
  const decoded = decodeTranscript(raw);
  const history = decoded.history.length > 0 ? decoded.history : null;
  let at = record.createdAt;
  const parsedAt = Date.parse(decoded.lastAt ?? "");
  if (!Number.isNaN(parsedAt)) at = parsedAt;
  if (!history) {
    // 空文件 = 从未聊过；有可解析记录但没有完整 assistant 轮次 = 中断写入，
    // 保持空消息（不是文件损坏）。只有有内容且零条记录能解析时，才判损坏。
    if (raw.trim().length === 0 || decoded.validRecords > 0) {
      record.messages = [];
      record.messageCount = 0;
      if (indexedMessageCount !== 0) options.persistIndex();
      return;
    }
    // 有内容但一行都解不开 = 损坏（如断电后的全 NUL 文件：目录项还在、
    // 数据块清零）。把坏文件移开自愈，注入一条可见告知。
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
    options.persistIndex();
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
  if (record.messageCount !== indexedMessageCount) options.persistIndex();
}
