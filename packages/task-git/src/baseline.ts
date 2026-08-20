/**
 * Baseline capture and overlay.
 *
 * captureBaseline() records the user's uncommitted work (staged, dirty,
 * untracked — renames, modes, binaries included) WITHOUT touching the Git
 * index: state comes from allowed probes plus direct file reads, hashes are
 * sha256-of-bytes (the same vocabulary as the task-workspace CAS/scanner,
 * computed locally with node:crypto so the algorithm cannot drift).
 *
 * overlayBaseline() replays those entries into a worktree with plain
 * file-level byte copies — no git index operations at all, so overlaid
 * staged/untracked files simply appear as worktree changes there. Source
 * bytes are read at overlay time ("current bytes win"), and a source file
 * that has disappeared since capture removes the worktree copy.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
// Reused (not redefined) so the whole workspace agrees on one containment policy.
import { isSafeRelativePath } from "@innocencecode/secure-storage-node";
import type { GitRunner } from "./git-process.ts";
import { detectGit, readGitStatus, type PorcelainChangeEntry } from "./status.ts";

/** sha256 hex of raw bytes — identical to task-workspace's CAS object keys. */
export function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface GitBaselineEntry {
  /** Repository-relative, "/"-separated. */
  path: string;
  /** Rename source path from porcelain v2; null otherwise. */
  origPath: string | null;
  /** Raw porcelain v2 XY codes ("??" for untracked). */
  xy: string;
  /** The index (staged) side changed relative to HEAD. */
  staged: boolean;
  /** The worktree side changed relative to the index. */
  dirty: boolean;
  /** Not tracked by Git at all. */
  untracked: boolean;
  /** sha256 of the current on-disk bytes; null when absent from the worktree. */
  hash: string | null;
  /** lstat mode & 0o7777 of the on-disk file; null when absent. */
  mode: number | null;
  /** Git index mode (e.g. 0o100644); null for untracked entries. */
  indexMode: number | null;
}

export interface GitBaseline {
  /** Canonical repository toplevel the baseline was captured from. */
  root: string;
  headCommit: string | null;
  branch: string | null;
  /** Every uncommitted change entry, sorted by path. */
  entries: GitBaselineEntry[];
}

/** Rejects relative paths that could escape a root or reach into .git. */
export function assertWritableGitPath(relativePath: string): void {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`task-git: unsafe relative path: ${JSON.stringify(relativePath)}`);
  }
  if (relativePath.split("/")[0] === ".git") {
    throw new Error(`task-git: refusing to write inside .git: ${JSON.stringify(relativePath)}`);
  }
}

function joinRepoPath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

async function readEntryState(root: string, relativePath: string): Promise<{ hash: string | null; mode: number | null }> {
  const absolute = joinRepoPath(root, relativePath);
  try {
    const [bytes, lstat] = await Promise.all([fs.readFile(absolute), fs.lstat(absolute)]);
    return { hash: sha256(new Uint8Array(bytes)), mode: lstat.mode & 0o7777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { hash: null, mode: null };
    }
    throw error;
  }
}

/** Expands a porcelain-untracked directory into its file paths. */
async function expandUntrackedDir(root: string, dirRelative: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(relativeDir: string): Promise<void> {
    const entries = await fs.readdir(joinRepoPath(root, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") {
        continue; // never touch nested repository metadata
      }
      const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  await walk(dirRelative.replace(/\/+$/, ""));
  return files.sort();
}

function untrackedEntry(relativePath: string, state: { hash: string | null; mode: number | null }): GitBaselineEntry {
  return {
    path: relativePath,
    origPath: null,
    xy: "??",
    staged: false,
    dirty: false,
    untracked: true,
    hash: state.hash,
    mode: state.mode,
    indexMode: null,
  };
}

function trackedEntry(entry: PorcelainChangeEntry, state: { hash: string | null; mode: number | null }): GitBaselineEntry {
  const x = entry.xy.charAt(0);
  const y = entry.xy.charAt(1);
  return {
    path: entry.path,
    origPath: entry.origPath,
    xy: entry.xy,
    staged: x !== "." && x !== "?",
    dirty: y !== "." && y !== "?",
    untracked: false,
    hash: state.hash,
    mode: state.mode,
    indexMode: entry.indexMode,
  };
}

/**
 * Captures the uncommitted baseline of a Git workspace. Uses only allowed
 * probes plus direct file reads; the index, worktree files and porcelain
 * output are byte-identical afterwards.
 */
export async function captureBaseline(git: GitRunner, root: string): Promise<GitBaseline> {
  const info = await detectGit(git, root);
  const status = await readGitStatus(git, info.root);
  const entries: GitBaselineEntry[] = [];

  for (const entry of status.entries) {
    if (entry.kind === "untracked") {
      if (entry.path.endsWith("/")) {
        // porcelain collapses untracked directories; capture the files
        for (const filePath of await expandUntrackedDir(info.root, entry.path)) {
          entries.push(untrackedEntry(filePath, await readEntryState(info.root, filePath)));
        }
      } else {
        entries.push(untrackedEntry(entry.path, await readEntryState(info.root, entry.path)));
      }
      continue;
    }
    entries.push(trackedEntry(entry, await readEntryState(info.root, entry.path)));
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root: info.root, headCommit: info.headCommit, branch: info.branch, entries };
}

/**
 * Atomic file write inside a root: temp file in the same directory, fsync,
 * rename. A read-only bit on an EXISTING target is cleared first — Windows
 * refuses to rename over READONLY files (EPERM), which would otherwise break
 * re-overlay, recovery replay and baseline restore for that file class. The
 * final mode is applied (best-effort) after the rename.
 */
export async function writeGitFile(
  root: string,
  relativePath: string,
  content: Uint8Array,
  mode: number | null,
): Promise<void> {
  assertWritableGitPath(relativePath);
  const target = joinRepoPath(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const handle = await fs.open(temp, "w");
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Clear a readonly target before the rename (ENOENT when absent is fine).
    await fs.chmod(target, 0o666).catch(() => undefined);
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  if (mode !== null) {
    await fs.chmod(target, mode).catch(() => undefined); // best-effort on exotic filesystems
  }
}

/**
 * Copies the baseline's current bytes into a worktree (file-level, no git
 * index operations). Entries whose source file has since disappeared remove
 * the worktree copy; files land as worktree modifications or untracked files.
 */
export async function overlayBaselineAt(worktreeRoot: string, baseline: GitBaseline): Promise<void> {
  for (const entry of baseline.entries) {
    assertWritableGitPath(entry.path);
    const source = joinRepoPath(baseline.root, entry.path);
    let content: Uint8Array | null = null;
    let mode: number | null = null;
    try {
      const [bytes, lstat] = await Promise.all([fs.readFile(source), fs.lstat(source)]);
      content = new Uint8Array(bytes);
      mode = lstat.mode & 0o7777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (content === null) {
      await fs.rm(joinRepoPath(worktreeRoot, entry.path), { force: true });
      continue;
    }
    await writeGitFile(worktreeRoot, entry.path, content, mode);
  }
}
