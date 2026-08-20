/**
 * Checkpoint persistence: atomic JSON files at
 * `<taskRoot>/checkpoints/<checkpointId>.json`, written through the secure
 * storage API (0600 / current-user-only ACL). Ids are validated so a
 * checkpoint id can never traverse outside the checkpoints directory.
 */
import path from "node:path";
import type { SecureStorage } from "@innocencecode/secure-storage-node";
import type { Checkpoint } from "@innocencecode/task-core";

const CHECKPOINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeCheckpointId(checkpointId: string): string {
  if (!CHECKPOINT_ID_PATTERN.test(checkpointId) || checkpointId.includes("..")) {
    throw new Error(`checkpoint store: unsafe checkpoint id: ${JSON.stringify(checkpointId)}`);
  }
  return checkpointId;
}

export interface CheckpointStore {
  /** Atomically persists a checkpoint and returns its absolute path. */
  write(checkpoint: Checkpoint): Promise<string>;
  /** Reads a checkpoint; null when it does not exist. */
  read(checkpointId: string): Promise<Checkpoint | null>;
  /** Checkpoint ids currently on disk, sorted. */
  list(): Promise<string[]>;
}

function checkpointRelativePath(checkpointId: string): string {
  return `checkpoints/${assertSafeCheckpointId(checkpointId)}.json`;
}

export function createCheckpointStore(storage: SecureStorage): CheckpointStore {
  return {
    async write(checkpoint: Checkpoint): Promise<string> {
      return storage.writeFileAtomic(checkpointRelativePath(checkpoint.checkpointId), JSON.stringify(checkpoint, null, 2));
    },

    async read(checkpointId: string): Promise<Checkpoint | null> {
      try {
        const raw = await storage.readTextFile(checkpointRelativePath(checkpointId));
        return JSON.parse(raw) as Checkpoint;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },

    async list(): Promise<string[]> {
      const names = await storage.listDir("checkpoints");
      return names
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
        .filter((id) => CHECKPOINT_ID_PATTERN.test(id))
        .sort();
    },
  };
}

/** Absolute checkpoint file path (validated id); exposed for layout tests. */
export function checkpointAbsolutePath(storage: SecureStorage, checkpointId: string): string {
  return path.join(storage.resolve(checkpointRelativePath(checkpointId)));
}
