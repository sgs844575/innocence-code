// Turn persistence (split from runtime.ts by responsibility): appends one
// completed turn of a route to the session's JSONL transcript.
//
// Task-scoped turns are SKIPPED — the task commit flow (TurnCommitCoordinator
// + transcript sink) owns their durable turn-v3 rows, so the runtime must
// never double-write them. Non-task turns: the main route keeps turn-v2
// (host hydration depends on it); other routes append turn-v3 rows with
// explicit route identity (empty checkpointId — no checkpoint backs a
// non-task turn), which the decoder keeps OUT of the main history.
import fs from "node:fs/promises";
import path from "node:path";
import type { Message } from "@innocencecode/harness-session";
import { encodeTurnV2, encodeTurnV3 } from "./transcript";
import { DEFAULT_ROUTE_ID } from "./runtime-types";

let persistSeq = 0;
const nextEventId = () => `event_${Date.now().toString(36)}_${(persistSeq++).toString(36)}`;

export interface TurnPersistenceOptions {
  /** Transcript directory; null/undefined = no persistence. */
  persistDir?: string;
  /** Failure reporting (persistence is best-effort, never breaks a turn). */
  log: (level: "warn", msg: string, data?: unknown) => void;
}

export async function persistTurn(
  options: TurnPersistenceOptions,
  input: {
    sessionId: string;
    turnId: string;
    routeId: string;
    taskId: string;
    messages: Message[];
  },
): Promise<void> {
  const { sessionId, turnId, routeId, taskId, messages } = input;
  if (!options.persistDir || messages.length === 0 || taskId) return;
  try {
    await fs.mkdir(options.persistDir, { recursive: true });
    const line =
      routeId === DEFAULT_ROUTE_ID
        ? encodeTurnV2(turnId, new Date().toISOString(), messages)
        : encodeTurnV3({
            at: new Date().toISOString(),
            eventId: nextEventId(),
            turnId,
            routeId,
            parentTurnId: null,
            checkpointId: "",
            messages,
          });
    await fs.appendFile(path.join(options.persistDir, `${sessionId}.jsonl`), line, "utf8");
  } catch (err) {
    options.log("warn", "persist failed", String(err));
  }
}
