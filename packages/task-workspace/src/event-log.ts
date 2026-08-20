/**
 * File-backed task event log (events.jsonl): append + crash-recovery reads.
 *
 * Appends are JSONL lines written through the secure-storage append API
 * (fsync'd). Reads use task-core's {@link recoverTask} semantics: a truncated
 * FINAL record (crash mid-append) is ignored and reported, while a malformed
 * NON-final line surfaces as a structured TaskRecoveryError — never silently
 * skipped. An absent/empty log is a fresh task and recovers to null.
 *
 * REPAIR-BEFORE-APPEND: every append first makes the log append-safe. A torn
 * trailing fragment (crash mid-append, no newline) would otherwise merge with
 * the next appended line — silently swallowing that event, and poisoning the
 * log non-final after a second append. {@link FileEventLog.repair} atomically
 * rewrites the log truncated to its last complete record (and terminates a
 * complete-but-unterminated final record); appends onto a log with NON-final
 * corruption are refused (fail closed).
 */
import type { SecureStorage } from "@innocencecode/secure-storage-node";
import {
  recoverTask,
  TaskRecoveryError,
  type TaskEvent,
  type TaskEventLog,
  type TaskRecoveryResult,
} from "@innocencecode/task-core";

export interface FileEventLog extends TaskEventLog {
  /**
   * Recovery view over events.jsonl. Null when no log exists yet (fresh
   * task); throws a structured TaskRecoveryError for mid-file corruption.
   */
  recover(): Promise<TaskRecoveryResult | null>;
  /**
   * Makes the log append-safe: atomically drops a torn trailing fragment and
   * terminates an unterminated final record. True when a repair rewrote the
   * file. Throws TaskRecoveryError for NON-final corruption (append refused).
   */
  repair(): Promise<boolean>;
}

/**
 * Byte offset just past the newline that terminates the last COMPLETE record.
 * Only meaningful after recoverTask confirmed every line before the tail
 * parses; stops at the first unparseable line (the torn final fragment).
 */
function completeRegionEnd(raw: string): number {
  let end = 0;
  let start = 0;
  while (start < raw.length) {
    const nl = raw.indexOf("\n", start);
    const lineEnd = nl === -1 ? raw.length : nl;
    const line = raw.slice(start, lineEnd).trim();
    if (line !== "") {
      try {
        JSON.parse(line);
        end = nl === -1 ? raw.length : nl + 1;
      } catch {
        return end;
      }
    }
    if (nl === -1) {
      break;
    }
    start = nl + 1;
  }
  return end;
}

const ENDS_WITH_NEWLINE = /\r?\n$/;

export function createFileEventLog(storage: SecureStorage): FileEventLog {
  async function readRaw(): Promise<string> {
    try {
      return await storage.readTextFile("events.jsonl");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  return {
    async append(events: readonly TaskEvent[]): Promise<void> {
      if (events.length === 0) {
        return;
      }
      // Precondition: the log must be append-safe (no torn tail, terminated).
      await this.repair();
      const payload = events.map((event) => `${JSON.stringify(event)}\n`).join("");
      await storage.appendFile("events.jsonl", payload);
    },

    async list(): Promise<TaskEvent[]> {
      const recovery = await this.recover();
      return recovery === null ? [] : [...recovery.recoveredEvents];
    },

    async recover(): Promise<TaskRecoveryResult | null> {
      const raw = await readRaw();
      if (raw.trim() === "") {
        return null;
      }
      return recoverTask(raw);
    },

    async repair(): Promise<boolean> {
      const raw = await readRaw();
      if (raw === "") {
        return false;
      }
      // Fail closed on NON-final corruption: never append onto a poisoned log.
      const recovery = recoverTask(raw);
      if (!recovery.truncatedTail && ENDS_WITH_NEWLINE.test(raw)) {
        return false;
      }
      if (recovery.truncatedTail && ENDS_WITH_NEWLINE.test(raw)) {
        // A malformed final line that IS newline-terminated is not a plausible
        // torn append of this writer (every append ends with "\n"; a torn
        // write loses it). Reads keep tolerating it as a truncated tail, but
        // repair refuses to decide its fate — appending is denied.
        throw new TaskRecoveryError({
          kind: "incomplete-event",
          eventIndex: recovery.recoveredEvents.length,
          reason: "final record is corrupt but newline-terminated; refusing to append onto it",
        });
      }
      let text: string;
      if (recovery.truncatedTail) {
        // Torn append fragment (no trailing newline): drop it.
        text = raw.slice(0, completeRegionEnd(raw));
        if (text !== "" && !ENDS_WITH_NEWLINE.test(text)) {
          text += "\n";
        }
      } else {
        // Complete final record without its terminating newline.
        text = `${raw}\n`;
      }
      await storage.writeFileAtomic("events.jsonl", text);
      return true;
    },
  };
}
