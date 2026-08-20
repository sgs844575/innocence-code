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

type LeaseRead =
  | { kind: "lease"; lease: LockLease }
  /** ENOENT: the lock was released or recovered by someone else. */
  | { kind: "gone" }
  /** Readable but not a lease (empty, truncated or foreign content). */
  | { kind: "unparseable" }
  /** Read failed with an error other than ENOENT (e.g. transient EPERM/EBUSY/EISDIR). */
  | { kind: "unreadable" };

async function readLease(storage: SecureStorage, relativePath: string): Promise<LeaseRead> {
  let raw: string;
  try {
    raw = await storage.readTextFile(relativePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "gone" };
    }
    return { kind: "unreadable" };
  }
  const lease = parseLease(raw);
  return lease === null ? { kind: "unparseable" } : { kind: "lease", lease };
}

/**
 * Reads a lease, retrying briefly while the content does not parse or the
 * read fails transiently. Only ENOENT ("gone") is ever classified as a
 * missing lock; unparseable/unreadable states are NEVER treated as stale —
 * see acquireFileLock for why.
 */
async function readLeaseSettled(
  storage: SecureStorage,
  relativePath: string,
  attempts = 5,
  delayMs = 40,
): Promise<LeaseRead> {
  let last = await readLease(storage, relativePath);
  for (let attempt = 1; attempt < attempts && (last.kind === "unparseable" || last.kind === "unreadable"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    last = await readLease(storage, relativePath);
  }
  return last;
}

/**
 * Generic exclusive file-lock acquire loop shared by the workspace and task
 * leases. `key` is hashed into the lock file name; `lockDirRelative` is the
 * secure-storage subpath that holds the lock files.
 *
 * Staleness is decided ONLY by owner liveness, never by wall-clock timeouts:
 * a lock is recovered exclusively when its lease PARSES and its PID does not
 * exist, or its PID exists with a different start identity (PID reuse). A
 * lease that cannot be parsed or read might belong to a live (if stalled)
 * owner, so it is treated as actively held — the contender keeps retrying
 * until its AbortSignal fires; removing such a file needs an operator.
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
    // createFileExclusive publishes the lease atomically WITH its content
    // (temp + link), so a contender never observes an empty lock file.
    const created = await storage.createFileExclusive(relativePath, JSON.stringify(lease));
    if (created.created) {
      return makeHandle(storage, relativePath, lease);
    }

    const existing = await readLeaseSettled(storage, relativePath);

    if (existing.kind === "gone") {
      continue; // released or recovered while we were looking; retry create
    }
    if (existing.kind !== "lease") {
      // unparseable or unreadable: liveness cannot be PROVEN, so the lock
      // is treated as actively held. Never deleted, never timed out.
      await sleepWithSignal(backoff, signal);
      backoff = Math.min(Math.floor(backoff * 1.6), MAX_BACKOFF_MS);
      continue;
    }

    let stale = false;
    if (isPidAlive(existing.lease.pid)) {
      let startId = startIds.get(existing.lease.pid);
      if (startId === undefined) {
        startId = await readProcessStartId(existing.lease.pid);
        startIds.set(existing.lease.pid, startId);
      }
      if (startId !== null && startId !== existing.lease.processStartId) {
        stale = true; // same pid, different process: the owner is gone (PID reuse)
      } else {
        // live owner (or unverifiable identity — never steal)
      }
    } else {
      stale = true; // pid does not exist
    }

    if (!stale) {
      await sleepWithSignal(backoff, signal);
      backoff = Math.min(Math.floor(backoff * 1.6), MAX_BACKOFF_MS);
      continue;
    }

    // Stale (proven): delete only when the exact lease we judged is still on
    // disk. ANY other state — gone, changed token, or newly unparseable/
    // unreadable content — means we lost the race; never delete then.
    const current = await readLease(storage, relativePath);
    if (current.kind !== "lease" || current.lease.leaseToken !== existing.lease.leaseToken) {
      continue;
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
