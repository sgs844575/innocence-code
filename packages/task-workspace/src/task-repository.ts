/**
 * Task repository: the fixed on-disk layout for ONE task.
 *
 * Responsibilities (and nothing more):
 * - task head (task.json) read + ATOMIC write
 * - events.jsonl append + read (structurally implements task-core's
 *   TaskEventLog port)
 * - checkpoint persistence via the checkpoint store
 * - content objects via the content store
 *
 * The repository performs NO locking and NO commit coordination: callers
 * hold the task mutation lease (task-mutation-lock.ts) around mutations and
 * the workspace write lease around file apply/restore. TurnCommitCoordinator
 * and event-log recovery live in later packages.
 */
import type { TaskEvent, TaskEventLog, TaskHead, Checkpoint } from "@innocencecode/task-core";
import { createContentStore, type ContentStore } from "./content-store.ts";
import { createCheckpointStore, type CheckpointStore } from "./checkpoint-store.ts";
import { openPrivateTaskStorage, assertSafeTaskId, type PrivateTaskStorage } from "./private-task-storage.ts";

export interface TaskRepository extends TaskEventLog {
  readonly storage: PrivateTaskStorage;
  readonly objects: ContentStore;
  readonly checkpoints: CheckpointStore;
  /** Reads task.json; null when the task has no head yet. */
  readTaskHead(): Promise<TaskHead | null>;
  /** Atomically replaces task.json (writeTaskHead with a stale read is the caller's CAS bug, caught by the lease). */
  writeTaskHead(head: TaskHead): Promise<void>;
  writeCheckpoint(checkpoint: Checkpoint): Promise<void>;
  readCheckpoint(checkpointId: string): Promise<Checkpoint | null>;
}

export async function openTaskRepository(baseDir: string, taskId: string): Promise<TaskRepository> {
  const storage = await openPrivateTaskStorage(baseDir, assertSafeTaskId(taskId));
  const objects = createContentStore(storage.storage);
  const checkpoints = createCheckpointStore(storage.storage);

  return {
    storage,
    objects,
    checkpoints,

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
      if (events.length === 0) {
        return;
      }
      const payload = events.map((event) => `${JSON.stringify(event)}\n`).join("");
      await storage.storage.appendFile("events.jsonl", payload);
    },

    async list(): Promise<TaskEvent[]> {
      let raw: string;
      try {
        raw = await storage.storage.readTextFile("events.jsonl");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
      const events: TaskEvent[] = [];
      const lines = raw.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!.trim();
        if (line === "") {
          continue;
        }
        try {
          events.push(JSON.parse(line) as TaskEvent);
        } catch (error) {
          throw new Error(`task repository: corrupt events.jsonl at line ${index + 1}: ${String(error)}`);
        }
      }
      return events;
    },
  };
}
