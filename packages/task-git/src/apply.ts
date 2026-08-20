/**
 * Three-way preflight and apply for the ORIGINAL workspace.
 *
 * baseline (default) mode: before reverse-applying task increments, verify
 * that every affected file still holds its expected hash; any mismatch
 * writes nothing (all-or-nothing).
 *
 * isolated mode: before writing an accepted patch into the original
 * workspace, compare base/current/incoming hashes per file. A file is clean
 * when it still matches the base (applyable) or already matches the incoming
 * content (no-op); anything else conflicts and NOTHING is written.
 *
 * Writes are plain file operations (never git index operations): after a
 * successful apply, `git ls-files -s` and `git diff --cached` are
 * byte-identical. All content is materialized and hash-verified through the
 * injected reader BEFORE the first byte lands, so a bad port cannot leave a
 * half-written batch behind.
 *
 * DURABLE JOURNAL: when the caller injects a `journal` hook, the multi-file
 * write loop runs under the durable apply journal (the transaction shape is
 * structurally identical to task-workspace's ApplyJournal; recovery runs
 * through that package's recoverApplyJournals engine over the same storage).
 * The journal persists before the first byte lands, flips per entry after
 * each file, and commits after the batch — a process death at any point
 * leaves an on-disk record the recovery engine completes or rolls back.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { GitRunner } from "./git-process.ts";
import { assertWritableGitPath, sha256, writeGitFile } from "./baseline.ts";
import { detectGit } from "./status.ts";
import type { ContentReader } from "./worktree.ts";

// These DTOs intentionally mirror task-workspace's apply shapes by name and
// structure (the GitAdapter interface is the shared contract); they are
// defined locally so this CLI-only package stays independent of the CAS.
export interface FileConflict {
  path: string;
  expected: string | null;
  actual: string | null;
}

export interface ConflictReport {
  conflicts: FileConflict[];
  clean: boolean;
}

export interface ApplyResult {
  applied: string[];
  conflicts: FileConflict[];
}

/** Raised when the injected content reader returns mismatched bytes. */
export class GitApplyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitApplyError";
  }
}

export interface BaselineApplyFile {
  path: string;
  /** Hash the workspace file must currently hold (null = must be absent). */
  expectedHash: string | null;
  /** Hash to restore to (null = remove the increment by deleting the file). */
  restoreHash: string | null;
}

export interface BaselineApplyInput {
  mode: "baseline";
  root: string;
  files: readonly BaselineApplyFile[];
  readContent: ContentReader;
  /** Optional durable-journal hook; see the module header. */
  journal?: ApplyJournalHook;
}

export interface IsolatedApplyFile {
  path: string;
  /** Hash at the fork baseline; null when the file did not exist there. */
  baseHash: string | null;
  /** Hash of the accepted content; null = delete the file. */
  incomingHash: string | null;
}

export interface IsolatedApplyInput {
  mode: "isolated";
  root: string;
  files: readonly IsolatedApplyFile[];
  readContent: ContentReader;
  /** Optional durable-journal hook; see the module header. */
  journal?: ApplyJournalHook;
}

export type ApplyAcceptedInput = BaselineApplyInput | IsolatedApplyInput;

// ---------------------------------------------------------------------------
// Durable apply-journal hook (structural mirror of task-workspace's
// apply-journal.ts JSON shape; kept local so this CLI-only package stays
// independent of the CAS. Host-level type tests pin the two shapes equal.)
// ---------------------------------------------------------------------------

export interface ApplyJournalEntryDto {
  /** Workspace-relative path. */
  path: string;
  /** On-disk content hash when the transaction started (null: absent). */
  beforeHash: string | null;
  /** Backed-up pre-transaction content ref (null: file was absent). */
  backupRef: string | null;
  /** Hash the file must have after the transaction (null: absent). */
  desiredHash: string | null;
  applied: boolean;
}

export interface ApplyJournalDto {
  transactionId: string;
  createdAt: string;
  root: string;
  committed: boolean;
  entries: ApplyJournalEntryDto[];
}

export interface ApplyJournalHook {
  /** Persists the journal atomically; called before the first write, after
   *  every applied entry, and once more with committed: true. */
  write(journal: ApplyJournalDto): Promise<void>;
  /** Backs up pre-transaction bytes; returns the ref recovery restores from. */
  backup(path: string, bytes: Uint8Array): Promise<string>;
}

/** (path, desired hash) pairs; a null hash means "delete the file". */
type DesiredWrite = { path: string; hash: string | null };

function desiredWrites(input: ApplyAcceptedInput): DesiredWrite[] {
  if (input.mode === "baseline") {
    return input.files.map((file) => ({ path: file.path, hash: file.restoreHash }));
  }
  return input.files.map((file) => ({ path: file.path, hash: file.incomingHash }));
}

async function diskHash(root: string, relativePath: string): Promise<string | null> {
  try {
    const bytes = await fs.readFile(path.join(root, ...relativePath.split("/")));
    return sha256(new Uint8Array(bytes));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function collectConflicts(
  root: string,
  input: ApplyAcceptedInput,
): Promise<{ conflicts: FileConflict[]; actualByPath: Map<string, string | null> }> {
  const conflicts: FileConflict[] = [];
  const actualByPath = new Map<string, string | null>();
  if (input.mode === "baseline") {
    for (const file of input.files) {
      assertWritableGitPath(file.path);
      const actual = await diskHash(root, file.path);
      actualByPath.set(file.path, actual);
      if (actual !== file.expectedHash) {
        conflicts.push({ path: file.path, expected: file.expectedHash, actual });
      }
    }
    return { conflicts, actualByPath };
  }
  for (const file of input.files) {
    assertWritableGitPath(file.path);
    const actual = await diskHash(root, file.path);
    actualByPath.set(file.path, actual);
    if (actual === file.incomingHash || actual === file.baseHash) {
      continue; // already applied (no-op) or still at base (applyable)
    }
    conflicts.push({ path: file.path, expected: file.baseHash, actual });
  }
  return { conflicts, actualByPath };
}

/** Three-way preflight: reports conflicts without touching any file. */
export async function preflightApply(git: GitRunner, input: ApplyAcceptedInput): Promise<ConflictReport> {
  const info = await detectGit(git, input.root);
  const { conflicts } = await collectConflicts(info.root, input);
  return { conflicts, clean: conflicts.length === 0 };
}

/** Existing target mode (POSIX exec bit) preserved across overwrites. */
async function existingMode(root: string, relativePath: string): Promise<number | null> {
  try {
    const lstat = await fs.lstat(path.join(root, ...relativePath.split("/")));
    return lstat.mode & 0o7777;
  } catch {
    return null;
  }
}

/**
 * Applies (or reverse-applies) after a clean preflight. Any conflict writes
 * nothing; on success every file is written atomically and the applied paths
 * are returned. With an injected journal hook the multi-file write loop runs
 * under the durable apply journal (module header).
 */
export async function applyAccepted(git: GitRunner, input: ApplyAcceptedInput): Promise<ApplyResult> {
  const info = await detectGit(git, input.root);
  const { conflicts, actualByPath } = await collectConflicts(info.root, input);
  if (conflicts.length > 0) {
    return { applied: [], conflicts };
  }

  // Materialize and hash-verify ALL content before the first write.
  const writes: Array<{ path: string; hash: string | null; content: Uint8Array | null }> = [];
  for (const write of desiredWrites(input)) {
    if (write.hash === null) {
      writes.push({ path: write.path, hash: null, content: null });
      continue;
    }
    let content: Uint8Array;
    try {
      content = await input.readContent(write.hash);
    } catch (error) {
      throw new GitApplyError(`task-git: content unreadable for ${write.path}: ${String(error)}`, {
        cause: error,
      });
    }
    if (sha256(content) !== write.hash) {
      throw new GitApplyError(`task-git: content reader returned bytes not matching the hash for ${write.path}`);
    }
    writes.push({ path: write.path, hash: write.hash, content });
  }

  // Journal prep: persist the whole transaction (pre-transaction bytes backed
  // up into the caller's store) BEFORE the first write lands.
  const journalHook = input.journal;
  let journal: ApplyJournalDto | undefined;
  if (journalHook !== undefined) {
    const entries: ApplyJournalEntryDto[] = [];
    for (const write of writes) {
      const beforeHash = actualByPath.get(write.path) ?? null;
      let backupRef: string | null = null;
      if (beforeHash !== null) {
        const current = await fs.readFile(path.join(info.root, ...write.path.split("/")));
        backupRef = await journalHook.backup(write.path, new Uint8Array(current));
      }
      entries.push({
        path: write.path,
        beforeHash,
        backupRef,
        desiredHash: write.hash,
        applied: false,
      });
    }
    journal = {
      transactionId: randomUUID(),
      createdAt: new Date().toISOString(),
      root: info.root,
      committed: false,
      entries,
    };
    await journalHook.write(journal);
  }

  const applied: string[] = [];
  for (let index = 0; index < writes.length; index += 1) {
    const write = writes[index]!;
    if (write.content === null) {
      await fs.rm(path.join(info.root, ...write.path.split("/")), { force: true });
    } else {
      await writeGitFile(info.root, write.path, write.content, await existingMode(info.root, write.path));
    }
    applied.push(write.path);
    if (journal !== undefined && journalHook !== undefined) {
      // Entry flip AFTER the atomic rename: a death between the two leaves the
      // unrecorded-replacement window the recovery engine detects by content.
      journal.entries[index]!.applied = true;
      await journalHook.write(journal);
    }
  }

  if (journal !== undefined && journalHook !== undefined) {
    journal.committed = true;
    await journalHook.write(journal);
  }

  return { applied, conflicts: [] };
}
