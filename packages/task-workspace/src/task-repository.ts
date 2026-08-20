/**
 * Task repository: the fixed on-disk layout for ONE task.
 *
 * Responsibilities (and nothing more):
 * - task head (task.json) read + ATOMIC write
 * - events.jsonl append + recovery-aware read (delegates to event-log.ts,
 *   which structurally implements task-core's TaskEventLog port)
 * - checkpoint persistence via the checkpoint store
 * - content objects via the content store
 *
 * The repository performs NO locking and NO commit coordination: callers
 * hold the task mutation lease (task-mutation-lock.ts) around mutations and
 * the workspace write lease around file apply/restore. The fixed turn commit
 * order lives in turn-commit-coordinator.ts.
 */
import type { TaskEvent, TaskHead, TaskRecoveryResult, Checkpoint } from "@innocencecode/task-core";
import { createContentStore, type ContentStore } from "./content-store.ts";
import { createCheckpointStore, type CheckpointStore } from "./checkpoint-store.ts";
import { createFileEventLog, type FileEventLog } from "./event-log.ts";
import { openPrivateTaskStorage, assertSafeTaskId, type PrivateTaskStorage } from "./private-task-storage.ts";

export interface TaskRepository {
  readonly storage: PrivateTaskStorage;
  readonly objects: ContentStore;
  readonly checkpoints: CheckpointStore;
  readonly eventLog: FileEventLog;
  /** Reads task.json; null when the task has no head yet. */
  readTaskHead(): Promise<TaskHead | null>;
  /** Atomically replaces task.json (writeTaskHead with a stale read is the caller's CAS bug, caught by the lease). */
  writeTaskHead(head: TaskHead): Promise<void>;
  writeCheckpoint(checkpoint: Checkpoint): Promise<void>;
  readCheckpoint(checkpointId: string): Promise<Checkpoint | null>;
  append(events: readonly TaskEvent[]): Promise<void>;
  list(): Promise<TaskEvent[]>;
  /** Recovery view over events.jsonl; null when the log does not exist yet. */
  recoverEventLog(): Promise<TaskRecoveryResult | null>;
}

export async function openTaskRepository(baseDir: string, taskId: string): Promise<TaskRepository> {
  const storage = await openPrivateTaskStorage(baseDir, assertSafeTaskId(taskId));
  const objects = createContentStore(storage.storage);
  const checkpoints = createCheckpointStore(storage.storage);
  const eventLog = createFileEventLog(storage.storage);

  return {
    storage,
    objects,
    checkpoints,
    eventLog,

    async readTaskHead(): Promise<TaskHead | null> {
      try {
        const raw = await storage.storage.readTextFile("task.json");
        return JSON.parse(raw) as TaskHead;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },

    async writeTaskHead(head: TaskHead): Promise<void> {
      await storage.storage.writeFileAtomic("task.json", `${JSON.stringify(head, null, 2)}\n`);
    },

    async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
      await checkpoints.write(checkpoint);
    },

    async readCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
      return checkpoints.read(checkpointId);
    },

    async append(events: readonly TaskEvent[]): Promise<void> {
      await eventLog.append(events);
    },

    async list(): Promise<TaskEvent[]> {
      return eventLog.list();
    },

    async recoverEventLog(): Promise<TaskRecoveryResult | null> {
      return eventLog.recover();
    },
  };
}
