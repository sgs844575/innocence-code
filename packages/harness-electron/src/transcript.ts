// Transcript JSONL codec. New records are append-only turn-v2 rows; legacy
// records are full-history snapshots. Legacy decoding canonicalizes UI/coalesced
// tool shapes, groups messages into logical user turns, then merges snapshot
// sequences without raw-JSON prefix guessing.
import type { Message, MessagePart, ToolResultPart } from "@innocencecode/harness-core";

export interface TurnRecordV2 {
  at: string;
  type: "turn-v2";
  turnId: string;
  messages: Message[];
}

interface LegacyTurnRecord {
  at?: unknown;
  type?: unknown;
  user?: unknown;
  history?: unknown;
}

export interface DecodedTranscript {
  history: Message[];
  lastAt?: string;
  validRecords: number;
}

function validPart(raw: unknown): raw is MessagePart {
  if (typeof raw !== "object" || raw === null) return false;
  const p = raw as { type?: unknown };
  return p.type === "text" || p.type === "thinking" || p.type === "toolCall" || p.type === "toolResult";
}

function validMessage(raw: unknown): raw is Message {
  if (typeof raw !== "object" || raw === null) return false;
  const m = raw as { role?: unknown; parts?: unknown };
  return (m.role === "user" || m.role === "assistant") && Array.isArray(m.parts);
}

/** UI history may put toolResult parts inside assistant messages. Convert it
 * back to canonical harness shape: assistant blocks, then user result blocks. */
export function canonicalizeHistory(rawMessages: unknown[]): Message[] {
  const out: Message[] = [];
  for (const raw of rawMessages) {
    if (!validMessage(raw)) continue;
    const parts = raw.parts.filter(validPart);
    if (parts.length === 0) continue;
    if (raw.role === "user") {
      out.push({ role: "user", parts });
      continue;
    }
    let assistant: MessagePart[] = [];
    let results: ToolResultPart[] = [];
    const flushAssistant = () => {
      if (assistant.length > 0) out.push({ role: "assistant", parts: assistant });
      assistant = [];
    };
    const flushResults = () => {
      if (results.length > 0) out.push({ role: "user", parts: results });
      results = [];
    };
    for (const part of parts) {
      if (part.type === "toolResult") {
        flushAssistant();
        results.push(part);
      } else {
        flushResults();
        assistant.push(part);
      }
    }
    flushAssistant();
    flushResults();
  }
  return out;
}

function logicalTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  let current: Message[] = [];
  for (const message of messages) {
    const startsTurn =
      message.role === "user" &&
      message.parts.some((p) => p.type === "text" && p.text.length > 0);
    if (startsTurn && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function textOf(message: Message): string {
  return message.parts.filter((p) => p.type === "text").map((p) => p.text).join("");
}

/** A legacy record's top-level `user` field identifies the turn persisted by
 * that line. Find the last matching textual user message and take it through
 * the end of the snapshot. This is deterministic across cumulative snapshots,
 * restart fragments, canonical/UI shapes, and repeated identical prompts. */
function legacyCurrentTurn(record: LegacyTurnRecord): Message[] {
  if (!Array.isArray(record.history)) return [];
  const messages = canonicalizeHistory(record.history);
  const marker = typeof record.user === "string" ? record.user : "";
  if (!marker) return logicalTurns(messages).at(-1) ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user" && textOf(message) === marker) {
      return messages.slice(i);
    }
  }
  return logicalTurns(messages).at(-1) ?? [];
}

export function decodeTranscript(raw: string): DecodedTranscript {
  const history: Message[] = [];
  const seenTurnIds = new Set<string>();
  const seenRawLines = new Set<string>();
  let seededLegacy = false;
  let lastAt: string | undefined;
  let validRecords = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || seenRawLines.has(trimmed)) continue;
    seenRawLines.add(trimmed);
    let parsed: TurnRecordV2 | LegacyTurnRecord;
    try {
      parsed = JSON.parse(trimmed) as TurnRecordV2 | LegacyTurnRecord;
    } catch {
      continue;
    }
    if (typeof parsed.at === "string") lastAt = parsed.at;

    if (parsed.type === "turn-v2") {
      const record = parsed as TurnRecordV2;
      if (!Array.isArray(record.messages)) continue;
      validRecords += 1;
      if (seenTurnIds.has(record.turnId)) continue;
      seenTurnIds.add(record.turnId);
      history.push(...canonicalizeHistory(record.messages));
      continue;
    }

    const record = parsed as LegacyTurnRecord;
    if (!Array.isArray(record.history)) continue;
    validRecords += 1;
    const allTurns = logicalTurns(canonicalizeHistory(record.history));
    // Legacy runtime persisted only after a model turn completed. A user-only
    // snapshot is a torn/intermediate row, not a completed conversation turn.
    const completed = allTurns.filter((turn) => turn.some((m) => m.role === "assistant"));
    if (completed.length === 0) continue;
    if (!seededLegacy) {
      // The first surviving record may already be cumulative (earlier JSONL rows
      // were lost/truncated), so seed every completed turn it contains once.
      history.push(...completed.flat());
      seededLegacy = true;
    } else {
      const current = legacyCurrentTurn(record);
      if (current.some((m) => m.role === "assistant")) history.push(...current);
    }
  }
  return { history, lastAt, validRecords };
}

export function encodeTurnV2(turnId: string, at: string, messages: Message[]): string {
  const record: TurnRecordV2 = {
    at,
    type: "turn-v2",
    turnId,
    messages: canonicalizeHistory(messages),
  };
  return `${JSON.stringify(record)}\n`;
}
