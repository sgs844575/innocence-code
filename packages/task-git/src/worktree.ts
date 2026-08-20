/**
 * Worktree lifecycle: create (detached, from HEAD or an explicit base
 * commit), recover after a crash (validate directory + Git registration,
 * rebuild from the base commit, replay baseline and the last committed
 * checkpoint), destroy (remove --force + prune) and closeLease.
 *
 * closeLease deliberately releases NOTHING on disk: watchers, locks and
 * PTYs are released by the host bridge, and the worktree outlives app quit.
 * destroyWorktree runs only on explicit task/route deletion. Checkpoint
 * content arrives through an injected reader port — this package has no
 * CAS/storage dependency.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { GitRunner } from "./git-process.ts";
import { GitProcessError } from "./git-process.ts";
import type { GitBaseline } from "./baseline.ts";
import { assertWritableGitPath, overlayBaselineAt, sha256, writeGitFile } from "./baseline.ts";
import { detectGit } from "./status.ts";

export interface WorktreeLease {
  /** Opaque id identifying this lease instance. */
  leaseId: string;
  /** Repository toplevel (main worktree) the lease belongs to. */
  repoRoot: string;
  /** Absolute path of the linked worktree. */
  path: string;
  /** Commit the worktree is detached at. */
  baseCommit: string;
}

export interface CreateWorktreeInput {
  /** Any directory inside the repository. */
  root: string;
  /** Absolute path for the new worktree; caller owns placement policy. */
  path: string;
  /** Commit to detach from; defaults to the repository HEAD. */
  baseCommit?: string;
}

/** One file of the last committed checkpoint to replay during recovery. */
export interface GitCheckpointFile {
  path: string;
  /** sha256 of the checkpoint content; null when the file is absent there. */
  hash: string | null;
}

/** Reads the bytes stored under a sha256 content hash (injected port). */
export type ContentReader = (hash: string) => Promise<Uint8Array>;

export interface RecoverWorktreeInput {
  /** Any directory inside the repository. */
  root: string;
  /** Expected worktree path recorded by the route. */
  path: string;
  /** Base commit recorded by the route (rebuild target). */
  baseCommit: string;
  /** Baseline captured when the task opened. */
  baseline: GitBaseline;
  /** Files of the last committed checkpoint. */
  checkpointFiles: readonly GitCheckpointFile[];
  /** Reads checkpoint content by hash. */
  readContent: ContentReader;
}

/** Typed failure raised when a worktree cannot be recovered as recorded. */
export class GitRecoveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitRecoveryError";
  }
}

export interface WorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
}

/**
 * Canonical form of a path. The PARENT's realpath resolves Windows 8.3 short
 * forms (os.tmpdir hands out ADMINI~1-style paths while git prints the long
 * form), and works even when the path itself no longer exists.
 */
async function canonicalPath(value: string): Promise<string> {
  try {
    return path.join(await fs.realpath(path.dirname(value)), path.basename(value));
  } catch {
    return path.resolve(value);
  }
}

/** Case-insensitive-on-Windows path equality robust to short/long form differences. */
async function sameWorktreePath(a: string, b: string): Promise<boolean> {
  const [canonicalA, canonicalB] = await Promise.all([canonicalPath(a), canonicalPath(b)]);
  const normalizedA = process.platform === "win32" ? canonicalA.toLowerCase() : canonicalA;
  const normalizedB = process.platform === "win32" ? canonicalB.toLowerCase() : canonicalB;
  return normalizedA === normalizedB;
}

async function isRegistered(git: GitRunner, repoRoot: string, worktreePath: string): Promise<boolean> {
  const worktrees = await listWorktrees(git, repoRoot);
  for (const worktree of worktrees) {
    if (await sameWorktreePath(worktree.path, worktreePath)) {
      return true;
    }
  }
  return false;
}

/** Lists registered worktrees via `git worktree list --porcelain`. */
export async function listWorktrees(git: GitRunner, repoRoot: string): Promise<WorktreeInfo[]> {
  const output = (await git(["worktree", "list", "--porcelain"], repoRoot)).stdout.toString("utf8");
  const worktrees: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current !== null) {
        worktrees.push(current);
      }
      current = { path: line.slice("worktree ".length).trim(), head: null, branch: null, detached: false };
    } else if (current !== null && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (current !== null && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim();
    } else if (current !== null && line === "detached") {
      current.detached = true;
    } else if (line === "" && current !== null) {
      worktrees.push(current);
      current = null;
    }
  }
  if (current !== null) {
    worktrees.push(current);
  }
  return worktrees;
}

/** Creates a detached worktree and returns the lease for it. */
export async function createWorktree(git: GitRunner, input: CreateWorktreeInput): Promise<WorktreeLease> {
  const info = await detectGit(git, input.root); // throws GitWorkspaceError for non-Git roots
  const baseCommit = input.baseCommit ?? info.headCommit;
  if (baseCommit === null) {
    throw new GitProcessError(
      "task-git: cannot create a worktree from a repository without commits",
      "git worktree add",
    );
  }
  await fs.mkdir(path.dirname(path.resolve(input.path)), { recursive: true });
  await git(["worktree", "add", "--detach", input.path, baseCommit], info.root);
  return {
    leaseId: randomUUID(),
    repoRoot: info.root,
    path: path.resolve(input.path),
    baseCommit,
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function isEmptyDirectory(target: string): Promise<boolean> {
  const entries = await fs.readdir(target);
  return entries.length === 0;
}

/**
 * Recovers a worktree after a crash/restart. Validates that the directory
 * and its Git registration agree, rebuilds from the recorded base commit
 * when either is missing, then replays the baseline and the last committed
 * checkpoint (idempotent). Anything ambiguous (an unregistered non-empty
 * directory) throws GitRecoveryError — mapping that to a paused task is the
 * caller's job, this package never degrades the baseline.
 */
export async function recoverWorktree(git: GitRunner, input: RecoverWorktreeInput): Promise<WorktreeLease> {
  const info = await detectGit(git, input.root);
  const registered = await isRegistered(git, info.root, input.path);
  const exists = await pathExists(input.path);

  if (!registered || !exists) {
    if (exists) {
      // Unregistered leftover content must never be destroyed.
      if (!(await isEmptyDirectory(input.path))) {
        throw new GitRecoveryError(
          `task-git: worktree path exists but is not a registered Git worktree: ${input.path}`,
        );
      }
      await fs.rmdir(input.path);
    } else if (registered) {
      await git(["worktree", "prune"], info.root); // drop the stale registration
    }
    await fs.mkdir(path.dirname(path.resolve(input.path)), { recursive: true });
    try {
      await git(["worktree", "add", "--detach", input.path, input.baseCommit], info.root);
    } catch (error) {
      throw new GitRecoveryError(`task-git: failed to rebuild worktree at ${input.path}: ${String(error)}`, {
        cause: error,
      });
    }
  }

  const lease: WorktreeLease = {
    leaseId: randomUUID(),
    repoRoot: info.root,
    path: path.resolve(input.path),
    baseCommit: input.baseCommit,
  };

  await overlayBaselineAt(lease.path, input.baseline);

  for (const file of input.checkpointFiles) {
    assertWritableGitPath(file.path);
    if (file.hash === null) {
      await fs.rm(path.join(lease.path, ...file.path.split("/")), { force: true });
      continue;
    }
    let content: Uint8Array;
    try {
      content = await input.readContent(file.hash);
    } catch (error) {
      throw new GitRecoveryError(`task-git: checkpoint content unreadable for ${file.path}: ${String(error)}`, {
        cause: error,
      });
    }
    if (sha256(content) !== file.hash) {
      throw new GitRecoveryError(`task-git: checkpoint content hash mismatch for ${file.path}`);
    }
    await writeGitFile(lease.path, file.path, content, null);
  }

  return lease;
}

/**
 * Destroys a worktree (task/route deletion only): `git worktree remove
 * --force` followed by `git worktree prune`. Idempotent for an already
 * removed worktree.
 */
export async function destroyWorktree(git: GitRunner, lease: WorktreeLease): Promise<void> {
  try {
    await git(["worktree", "remove", "--force", lease.path], lease.repoRoot);
  } catch (error) {
    const stillRegistered = await isRegistered(git, lease.repoRoot, lease.path).catch(() => false);
    if (stillRegistered) {
      throw error;
    }
    // already gone on disk: fall through and prune the registration
  }
  await git(["worktree", "prune"], lease.repoRoot);
}

/**
 * Releases the lease WITHOUT any disk effect — the worktree survives app
 * quit; watcher/lock/PTY release happens in the host bridge. Only the lease
 * shape is validated.
 */
export async function closeLease(lease: WorktreeLease): Promise<void> {
  const keys = ["leaseId", "repoRoot", "path", "baseCommit"] as const;
  for (const key of keys) {
    const value = lease[key];
    if (typeof value !== "string" || value === "") {
      throw new Error(`task-git: invalid worktree lease (${key} is empty)`);
    }
  }
}
