import { randomUUID } from "node:crypto";
import type { TaskEvent } from "./events";

/**
 * Durable append-only event log port. Implementations persist JSON-safe
 * task events; the domain only defines the contract, never the storage.
 */
export interface TaskEventLog {
  append(events: readonly TaskEvent[]): Promise<void>;
  list(): Promise<TaskEvent[]>;
}

/**
 * Id/clock port injected into event factories so tests (and hosts) can
 * run the domain deterministically without reaching for real randomness.
 */
export interface TaskIdClock {
  newId(prefix?: string): string;
  now(): string;
}

/** Node-backed default: random UUIDs and ISO timestamp strings. */
export function createNodeIdClock(): TaskIdClock {
  return {
    newId(prefix) {
      const id = randomUUID();
      return prefix ? `${prefix}_${id}` : id;
    },
    now() {
      return new Date().toISOString();
    },
  };
}
