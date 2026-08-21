// Transcript DECODING half of the codec (see transcript.ts for the record
// types and encoders). Split by responsibility: this module canonicalizes
// message/part shapes and folds JSONL rows into history + the route map.
import type { Message, MessagePart, ToolResultPart } from "@innocencecode/harness-session";
import type { LegacyTurnRecord, TranscriptRoute, TurnRecordV2, TurnRecordV3 } from "./transcript";

/**
 * A decoded message: the canonical harness shape plus any parts whose type is
 * outside today's vocabulary (e.g. a future attachment part). Unknown-but-legal
 * parts are preserved verbatim on the message — never dropped, and never
 * misclassified as tool parts when canonical blocks are split.
 */
export interface DecodedMessage extends Message {
  readonly preservedParts?: readonly Record<string, unknown>[];
}

const KNOWN_PART_TYPES: ReadonlySet<string> = new Set(["text", "thinking", "toolCall", "toolResult"]);

function isKnownPart(raw: unknown): raw is MessagePart {
  if (typeof raw !== "object" || raw === null) return false;
  const p = raw as { type?: unknown };
  return typeof p.type === "string" && KNOWN_PART_TYPES.has(p.type);
}

/** Unknown-but-legal part: an object with a non-empty string `type` we do not know. */
function isUnknownLegalPart(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const type = (raw as { type?: unknown }).type;
  return typeof type === "string" && type.length > 0 && !KNOWN_PART_TYPES.has(type);
}

function validMessage(raw: unknown): raw is { role: "user" | "assistant"; parts: unknown[] } {
  if (typeof raw !== "object" || raw === null) return false;
  const m = raw as { role?: unknown; parts?: unknown };
  return (m.role === "user" || m.role === "assistant") && Array.isArray(m.parts);
}

/** Known parts, plus preserved unknown parts — from the parts array AND from an
 * already-decoded message's `preservedParts` field (re-canonicalization). */
function classifyParts(message: { parts: readonly unknown[]; preservedParts?: unknown }): {
  parts: MessagePart[];
  preserved: Record<string, unknown>[];
} {
  const parts: MessagePart[] = [];
  const preserved: Record<string, unknown>[] = [];
  for (const raw of message.parts) {
    if (isKnownPart(raw)) parts.push(raw);
    else if (isUnknownLegalPart(raw)) preserved.push(raw);
  }
  if (Array.isArray(message.preservedParts)) {
    for (const raw of message.preservedParts) {
      if (isUnknownLegalPart(raw)) preserved.push(raw);
    }
  }
  return { parts, preserved };
}

/**
 * UI history may put toolResult parts inside assistant messages. Convert it
 * back to canonical harness shape: assistant blocks, then user result blocks.
 * Unknown-but-legal parts stay on their original message: they attach to the
 * message's last canonical block (or form a block of their own when the
 * message produced none) and are NEVER treated as tool parts.
 */
export function canonicalizeHistory(rawMessages: readonly unknown[]): DecodedMessage[] {
  const out: DecodedMessage[] = [];
  for (const raw of rawMessages) {
    if (!validMessage(raw)) continue;
    const { parts, preserved } = classifyParts(raw);
    if (parts.length === 0 && preserved.length === 0) continue;
    if (raw.role === "user") {
      out.push(
        preserved.length === 0
          ? { role: "user", parts }
          : { role: "user", parts, preservedParts: preserved.map((p) => ({ ...p })) },
      );
      continue;
    }

    const blocks: DecodedMessage[] = [];
    let assistant: MessagePart[] = [];
    let results: ToolResultPart[] = [];
    const flushAssistant = () => {
      if (assistant.length > 0) blocks.push({ role: "assistant", parts: assistant });
      assistant = [];
    };
    const flushResults = () => {
      if (results.length > 0) blocks.push({ role: "user", parts: results });
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

    if (blocks.length === 0) {
      blocks.push({ role: "assistant", parts: [], preservedParts: preserved.map((p) => ({ ...p })) });
    } else {
      const last = blocks[blocks.length - 1]!;
      blocks[blocks.length - 1] = { ...last, preservedParts: preserved.map((p) => ({ ...p })) };
    }
    out.push(...blocks);
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

/** turn-v2 rows (and legacy snapshots) belong to the implicit "main" route. */
const MAIN_ROUTE = "main";

/** Internal mutable accumulator entry (narrowed to TranscriptRoute on return). */
interface RouteEntry {
  routeId: string;
  parentTurnId: string | null;
  turnIds: string[];
}

function routeOf(routes: Map<string, RouteEntry>, routeId: string, parentTurnId: string | null): RouteEntry {
  const existing = routes.get(routeId);
  if (existing === undefined) {
    const route: RouteEntry = { routeId, parentTurnId, turnIds: [] };
    routes.set(routeId, route);
    return route;
  }
  return existing;
}

function isTurnRecordV3Shape(record: Record<string, unknown>): boolean {
  return (
    typeof record.turnId === "string" &&
    record.turnId.length > 0 &&
    typeof record.routeId === "string" &&
    record.routeId.length > 0 &&
    typeof record.eventId === "string" &&
    typeof record.checkpointId === "string" &&
    (record.parentTurnId === null || typeof record.parentTurnId === "string") &&
    Array.isArray(record.messages)
  );
}

export interface DecodedTranscript {
  /** Main-route conversation history (v2 rows, v3 "main" rows, legacy snapshots). */
  history: DecodedMessage[];
  /** Route map: v2 rows map to "main"; v3 rows carry explicit route identity. */
  routes: ReadonlyMap<string, TranscriptRoute>;
  lastAt?: string;
  validRecords: number;
}

/**
 * Decodes transcript JSONL text. turn-v2 rows and legacy snapshots feed the
 * "main" route history (old lines are read, never rewritten); turn-v3 rows
 * carry explicit route identity, and ancestry is restored through each route's
 * `parentTurnId`. Messages of non-main routes are reachable via the route map
 * and are NOT merged into the main `history`.
 */
export function decodeTranscript(raw: string): DecodedTranscript {
  const history: DecodedMessage[] = [];
  const routes = new Map<string, RouteEntry>();
  const seenTurnIds = new Set<string>();
  const seenRawLines = new Set<string>();
  let seededLegacy = false;
  let lastAt: string | undefined;
  let validRecords = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || seenRawLines.has(trimmed)) continue;
    seenRawLines.add(trimmed);
    let parsed: TurnRecordV2 | TurnRecordV3 | LegacyTurnRecord;
    try {
      parsed = JSON.parse(trimmed) as TurnRecordV2 | TurnRecordV3 | LegacyTurnRecord;
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
      routeOf(routes, MAIN_ROUTE, null).turnIds.push(record.turnId);
      history.push(...canonicalizeHistory(record.messages));
      continue;
    }

    if (parsed.type === "turn-v3") {
      const record = parsed as unknown as Record<string, unknown>;
      if (!isTurnRecordV3Shape(record)) continue;
      const v3Record = parsed as TurnRecordV3;
      validRecords += 1;
      if (seenTurnIds.has(v3Record.turnId)) continue;
      seenTurnIds.add(v3Record.turnId);
      routeOf(routes, v3Record.routeId, v3Record.parentTurnId).turnIds.push(v3Record.turnId);
      if (v3Record.routeId === MAIN_ROUTE) {
        history.push(...canonicalizeHistory(v3Record.messages));
      }
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
  return { history, routes, lastAt, validRecords };
}
