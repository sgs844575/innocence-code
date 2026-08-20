/**
 * Fixed private task layout under a host-provided base directory (e.g.
 * Electron userData; a temp dir in tests):
 *
 *   <base>/tasks/<taskId>/objects/<sha256>
 *   <base>/tasks/<taskId>/checkpoints/<checkpointId>.json
 *   <base>/tasks/<taskId>/events.jsonl
 *   <base>/tasks/<taskId>/task.json
 *   <base>/tasks/<taskId>/{backup,temp,apply-journal}/
 *   <base>/locks/{workspace,task}/...     (cross-process leases)
 *
 * Every directory is created through secure-storage-node (0700 / Windows
 * current-user-only ACL). Task ids are validated so they can only ever name
 * a single directory segment under tasks/.
 */
import path from "node:path";
import { openSecureStorage, type SecureStorage } from "@innocencecode/secure-storage-node";

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Task ids must be one safe directory segment (no traversal, separators, or hidden names). */
export function assertSafeTaskId(taskId: string): string {
  if (!TASK_ID_PATTERN.test(taskId) || taskId.includes("..")) {
    throw new Error(`task storage: unsafe task id: ${JSON.stringify(taskId)}`);
  }
  return taskId;
}

const TASK_DIRS = ["objects", "checkpoints", "events", "backup", "temp", "apply-journal"] as const;
const LOCK_DIRS = ["locks", "locks/workspace", "locks/task"] as const;

export interface PrivateTaskStorage {
  readonly taskId: string;
  /** <base>/tasks/<taskId> */
  readonly taskRoot: string;
  /** Base-level storage; workspace/task lease files live under it. */
  readonly locksStorage: SecureStorage;
  /** Task-level storage rooted at taskRoot. */
  readonly storage: SecureStorage;
  readonly objectsDir: string;
  readonly checkpointsDir: string;
  readonly backupDir: string;
  readonly tempDir: string;
  readonly applyJournalDir: string;
  /** <taskRoot>/events.jsonl */
  readonly eventsPath: string;
  /** <taskRoot>/task.json */
  readonly taskHeadPath: string;
}

export function taskRootPath(baseDir: string, taskId: string): string {
  return path.join(path.resolve(baseDir), "tasks", assertSafeTaskId(taskId));
}

/**
 * Opens (creating when absent) the hardened private layout for one task.
 * Both storages stay open for the lifetime of the task session.
 */
export async function openPrivateTaskStorage(baseDir: string, taskId: string): Promise<PrivateTaskStorage> {
  assertSafeTaskId(taskId);
  const locksStorage = await openSecureStorage(path.resolve(baseDir), { dirs: LOCK_DIRS });
  const storage = await openSecureStorage(taskRootPath(baseDir, taskId), { dirs: TASK_DIRS });
  return {
    taskId,
    taskRoot: storage.root,
    locksStorage,
    storage,
    objectsDir: storage.subdir("objects"),
    checkpointsDir: storage.subdir("checkpoints"),
    backupDir: storage.subdir("backup"),
    tempDir: storage.subdir("temp"),
    applyJournalDir: storage.subdir("apply-journal"),
    eventsPath: storage.resolve("events.jsonl"),
    taskHeadPath: storage.resolve("task.json"),
  };
}
