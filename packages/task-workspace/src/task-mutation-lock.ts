/**
 * Cross-process task mutation lease.
 *
 * Serializes every mutation of one task's private data (head CAS, event
 * append, checkpoint writes, TurnCommitCoordinator sequences, review and
 * route mutations, recovery). The lock file lives at
 * `<base>/locks/task/<sha256(taskId)>.lock` and uses exactly the workspace
 * lock's lease format and staleness rules (see workspace-lock.ts): PID
 * liveness plus process start identity, never timeouts.
 *
 * LOCK ORDER: when a mutation needs BOTH leases, always
 *   task lease  ->  workspace lease
 * and never the reverse, or two writers can deadlock.
 */
import type { SecureStorage } from "@innocencecode/secure-storage-node";
import { acquireFileLock, sha256Hex, type LockOwner } from "./workspace-lock.ts";

export interface TaskMutationLock {
  acquire(taskId: string, owner: LockOwner, signal?: AbortSignal): Promise<AsyncDisposable>;
}

export function taskLockRelativePath(taskId: string): string {
  return `locks/task/${sha256Hex(taskId)}.lock`;
}

export function createTaskMutationLock(storage: SecureStorage): TaskMutationLock {
  return {
    async acquire(taskId, owner, signal) {
      return acquireFileLock(storage, "locks/task", taskId, owner, signal);
    },
  };
}

export type { LockHandle } from "./workspace-lock.ts";
