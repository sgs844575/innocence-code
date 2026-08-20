/**
 * File-backed task event log (events.jsonl): append + crash-recovery reads.
 *
 * Appends are JSONL lines written through the secure-storage append API
 * (fsync'd). Reads use task-core's {@link recoverTask} semantics: a truncated
 * FINAL record (crash mid-append) is ignored and reported, while a malformed
 * NON-final line surfaces as a structured TaskRecoveryError — never silently
 * skipped. An absent/empty log is a fresh task and recovers to null.
 */
import type { SecureStorage } from "@innocencecode/secure-storage-node";
import { recoverTask, type TaskEvent, type TaskEventLog, type TaskRecoveryResult } from "@innocencecode/task-core";

export interface FileEventLog extends TaskEventLog {
  /**
   * Recovery view over events.jsonl. Null when no log exists yet (fresh
   * task); throws a structured TaskRecoveryError for mid-file corruption.
   */
  recover(): Promise<TaskRecoveryResult | null>;
}

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
  };
}
