/**
 * Cross-process workspace write lease.
 *
 * The lock is a single file created with exclusive (O_EXCL) semantics under
 * `<base>/locks/workspace/<sha256(realpath(workspaceKey))>.lock`, holding a
 * lease { pid, processStartId, taskId, routeId, leaseToken }.
 *
 * Staleness is decided by OWNER LIVENESS, never by wall-clock timeout:
 * - PID missing (signal-0 probe)                        -> stale
 * - PID alive but its start identity differs (PID reuse) -> stale
 * - PID alive with the recorded start identity           -> active owner:
 *   retry with backoff until the AbortSignal fires
 * - identity unreadable                                   -> assume active
 *
 * LOCK ORDER: whenever a task mutation also needs to write workspace files,
 * take the task lease FIRST and the workspace lease SECOND; never the
 * reverse (see task-mutation-lock.ts).
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SecureStorage } from "@innocencecode/secure-storage-node";

const execFileAsync = promisify(execFileCallback);

export interface LockLease {
  pid: number;
  /** Platform process start identity; distinguishes PID reuse. */
  processStartId: string;
  taskId: string;
  routeId: string | null;
  leaseToken: string;
}

export interface LockOwner {
  taskId: string;
  routeId?: string | null;
}

export interface LockHandle extends AsyncDisposable {
  readonly lease: LockLease;
  readonly lockPath: string;
  release(): Promise<void>;
}

export interface WorkspaceWriteLock {
  acquire(workspaceKey: string, owner: { taskId: string; routeId: string }, signal?: AbortSignal): Promise<AsyncDisposable>;
}

const INITIAL_BACKOFF_MS = 20;
const MAX_BACKOFF_MS = 200;
export const LOCK_ACQUIRE_ABORTED = "lock acquire aborted";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Signal-0 liveness probe. EPERM means the process exists but is not ours. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Process start identity for a PID.
 * - Windows: the process start time as a file-time integer (powershell).
 * - Linux: /proc/<pid>/stat field 22 (starttime).
 * - Other POSIX: `ps -o lstart=` timestamp.
 * Returns null when the identity cannot be read; callers must then treat
 * the lock as owned by a live process (never steal what cannot be verified).
 */
export async function readProcessStartId(pid: number): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${pid}).StartTime.ToFileTime()`,
      ]);
      const value = stdout.trim();
      return value === "" ? null : value;
    }
    if (process.platform === "linux") {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const tail = stat.slice(stat.lastIndexOf(")") + 2);
      const fields = tail.split(" ");
      return fields[19] ?? null; // field 22 overall = starttime
    }
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const value = stdout.trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

let ownStartIdPromise: Promise<string> | null = null;

/** Start identity of THIS process (stable for its lifetime, resolved once). */
export function currentProcessStartId(): Promise<string> {
  ownStartIdPromise ??= readProcessStartId(process.pid).then((value) => {
    if (value === null) {
      throw new Error("lock: unable to determine the current process start identity");
    }
    return value;
  });
  return ownStartIdPromise;
}

function parseLease(raw: string): LockLease | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockLease>;
    if (typeof parsed.pid === "number" && typeof parsed.leaseToken === "string") {
      return {
        pid: parsed.pid,
        processStartId: typeof parsed.processStartId === "string" ? parsed.processStartId : "",
        taskId: typeof parsed.taskId === "string" ? parsed.taskId : "",
        routeId: typeof parsed.routeId === "string" ? parsed.routeId : null,
        leaseToken: parsed.leaseToken,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error(LOCK_ACQUIRE_ABORTED));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal!.removeEventListener("abort", onAbort);
      reject(new Error(LOCK_ACQUIRE_ABORTED));
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function makeHandle(storage: SecureStorage, relativePath: string, lease: LockLease): LockHandle {
  let released = false;
  const release = async (): Promise<void> => {
    if (released) {
      return;
    }
    released = true;
    try {
      const raw = await storage.readTextFile(relativePath).catch(() => null);
      const current = raw === null ? null : parseLease(raw);
      // Only remove OUR lock; a recovered/reacquired lock belongs to someone else.
      if (current !== null && current.leaseToken === lease.leaseToken) {
        await storage.deleteFile(relativePath);
      }
    } catch {
      // Release is best effort; stale recovery covers the rest.
    }
  };
  return {
    lease,
    lockPath: storage.resolve(relativePath),
    release,
    [Symbol.asyncDispose]: release,
  };
}

/**
 * Reads a lease, retrying briefly when the content does not parse yet: the
 * winner of O_EXCL creates the file before its content is flushed, so a
 * concurrent contender can briefly observe an empty file. Only a lease that
 * stays unparseable (or vanishes) is reported as unreadable.
 */
async function readLeaseSettled(
  storage: SecureStorage,
  relativePath: string,
  attempts = 5,
  delayMs = 40,
): Promise<{ raw: string | null; lease: LockLease | null }> {
  for (let attempt = 0; ; attempt += 1) {
    let raw: string | null = null;
    try {
      raw = await storage.readTextFile(relativePath);
    } catch {
      raw = null; // vanished (released or recovered)
    }
    const lease = raw === null ? null : parseLease(raw);
    if (lease !== null || raw === null || attempt >= attempts - 1) {
      return { raw, lease };
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/**
 * Generic exclusive file-lock acquire loop shared by the workspace and task
 * leases. `key` is hashed into the lock file name; `lockDirRelative` is the
 * secure-storage subpath that holds the lock files.
 */
export async function acquireFileLock(
  storage: SecureStorage,
  lockDirRelative: string,
  key: string,
  owner: LockOwner,
  signal?: AbortSignal,
): Promise<LockHandle> {
  const relativePath = `${lockDirRelative}/${sha256Hex(key)}.lock`;
  const lease: LockLease = {
    pid: process.pid,
    processStartId: await currentProcessStartId(),
    taskId: owner.taskId,
    routeId: owner.routeId ?? null,
    leaseToken: randomUUID(),
  };
  // Identity can only change through death+reuse, so one probe per pid per
  // acquire attempt is enough (and keeps the powershell cost bounded).
  const startIds = new Map<number, string | null>();
  let backoff = INITIAL_BACKOFF_MS;

  for (;;) {
    if (signal?.aborted) {
      throw new Error(LOCK_ACQUIRE_ABORTED);
    }
    const created = await storage.createFileExclusive(relativePath, JSON.stringify(lease));
    if (created.created) {
      return makeHandle(storage, relativePath, lease);
    }

    const existing = await readLeaseSettled(storage, relativePath);

    let stale = existing.lease === null; // still-unparseable lease: writer died mid-write
    if (existing.lease !== null) {
      if (isPidAlive(existing.lease.pid)) {
        let startId = startIds.get(existing.lease.pid);
        if (startId === undefined) {
          startId = await readProcessStartId(existing.lease.pid);
          startIds.set(existing.lease.pid, startId);
        }
        if (startId !== null && startId !== existing.lease.processStartId) {
          stale = true; // same pid, different process: the owner is gone
        }
      } else {
        stale = true; // pid does not exist
      }
    }

    if (!stale) {
      await sleepWithSignal(backoff, signal);
      backoff = Math.min(Math.floor(backoff * 1.6), MAX_BACKOFF_MS);
      continue;
    }

    // Stale: delete only when the token we judged is still on disk, so a
    // concurrent recoverer's fresh lock can never be deleted.
    const current = await readLeaseSettled(storage, relativePath, 1);
    if (current.lease !== null && existing.lease !== null && current.lease.leaseToken !== existing.lease.leaseToken) {
      continue; // already recovered and possibly reacquired
    }
    await storage.deleteFile(relativePath);
  }
}

/** Canonical workspace identity: realpath when it exists, else the resolved path. */
export async function canonicalWorkspaceKey(workspaceKey: string): Promise<string> {
  try {
    return await fs.realpath(workspaceKey);
  } catch {
    return path.resolve(workspaceKey);
  }
}

export function workspaceLockRelativePath(workspaceKey: string): string {
  return `locks/workspace/${sha256Hex(workspaceKey)}.lock`;
}

export function createWorkspaceWriteLock(storage: SecureStorage): WorkspaceWriteLock {
  return {
    async acquire(workspaceKey, owner, signal) {
      const key = await canonicalWorkspaceKey(workspaceKey);
      return acquireFileLock(storage, "locks/workspace", key, owner, signal);
    },
  };
}
