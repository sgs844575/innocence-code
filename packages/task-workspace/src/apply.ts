/**
 * Reverse apply and three-way preflight.
 *
 * applyReverse restores workspace files to their `before` state file by
 * file. Before ANY file is touched, every patch is preflighted: the current
 * on-disk hash must equal the expected hash recorded in the patch; a
 * mismatch is reported as a conflict and nothing is overwritten. The
 * multi-file replacement itself runs under a durable apply journal (see
 * apply-journal.ts) with per-file expected-hash verification.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { SecureStorage } from "@innocencecode/secure-storage-node";
import type { FileSnapshotRef } from "@innocencecode/task-core";
import type { ContentStore } from "./content-store.ts";
import { diskHash, resolveWorkspaceFile } from "./scanner.ts";
import type { FilePatch } from "./diff.ts";
import { recoverApplyJournals, writeJournal, type ApplyJournal, type ApplyJournalEntry, type RecoveryReport } from "./apply-journal.ts";

/** Sentinel thrown by the crash-injection hook; the journal stays uncommitted. */
export const APPLY_CRASH_SENTINEL = "apply-crash-after-files";

export interface ReverseApplyInput {
  root: string;
  patches: FilePatch[];
  /**
   * Test-only fault injection: after N files have been replaced (and the
   * journal updated), throw the crash sentinel exactly as a process death
   * would leave things — journal on disk, committed marker absent.
   */
  crashAfterFiles?: number;
  /**
   * Test-only fault injection: die after the Nth file's atomic rename has
   * landed but BEFORE the journal records it as applied — the on-disk file
   * holds desired content while the journal still says applied:false.
   * Recovery must detect and roll back this unrecorded replacement.
   */
  crashBetweenRenameAndJournal?: number;
}

export interface FileConflict {
  path: string;
  expected: string | null;
  actual: string | null;
}

export interface ApplyResult {
  applied: string[];
  conflicts: FileConflict[];
}

export interface ThreeWayInput {
  root: string;
  /** Workspace state when the change started (fork baseline / turn start). */
  base: FileSnapshotRef[];
  /** Desired final workspace state. */
  target: FileSnapshotRef[];
}

export interface ConflictReport {
  conflicts: FileConflict[];
  clean: boolean;
}

export interface ApplyDeps {
  storage: SecureStorage;
  contentStore: ContentStore;
}

async function replaceWorkspaceFile(root: string, relativePath: string, content: Uint8Array, transactionId: string): Promise<void> {
  const target = resolveWorkspaceFile(root, relativePath);
  // Temp file next to the target keeps the rename same-volume/atomic.
  const temp = `${target}.${transactionId.slice(0, 8)}.tmp`;
  const handle = await fs.open(temp, "w");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

async function applyEntry(root: string, entry: ApplyJournalEntry, contentStore: ContentStore, transactionId: string): Promise<void> {
  // Belt-and-braces per-file expected-hash check immediately before replace.
  const current = await diskHash(root, entry.path);
  if (current !== entry.beforeHash) {
    throw new Error(`apply: workspace changed under transaction at ${entry.path}`);
  }
  if (entry.desiredHash === null) {
    await fs.rm(resolveWorkspaceFile(root, entry.path), { force: true });
    return;
  }
  const desired = await contentStore.get(entry.desiredHash);
  await replaceWorkspaceFile(root, entry.path, desired, transactionId);
}

/**
 * Restores every patch's path to its before state. Desired content is read
 * from the content store (the caller snapshots before-content into the CAS
 * when checkpoints are taken); pre-transaction content is backed up into the
 * CAS under the journal so recovery can roll back byte-exactly.
 */
export async function applyReverse(input: ReverseApplyInput, deps: ApplyDeps): Promise<ApplyResult> {
  const root = await fs.realpath(input.root);
  const conflicts: FileConflict[] = [];
  const entries: ApplyJournalEntry[] = [];

  for (const patch of input.patches) {
    resolveWorkspaceFile(root, patch.path); // containment check up front
    const expected = patch.after.exists ? patch.after.hash : null;
    const actual = await diskHash(root, patch.path);
    if (actual !== expected) {
      conflicts.push({ path: patch.path, expected, actual });
      continue;
    }
    let backupRef: string | null = null;
    if (actual !== null) {
      const current = await fs.readFile(resolveWorkspaceFile(root, patch.path));
      backupRef = (await deps.contentStore.put(new Uint8Array(current))).key;
    }
    entries.push({
      path: patch.path,
      beforeHash: actual,
      backupRef,
      desiredHash: patch.before.exists ? patch.before.hash : null,
      applied: false,
    });
  }
  // Any conflict aborts the whole transaction: no file is touched.
  if (conflicts.length > 0) {
    return { applied: [], conflicts };
  }

  const journal: ApplyJournal = {
    transactionId: randomUUID(),
    createdAt: new Date().toISOString(),
    root,
    committed: false,
    entries,
  };
  await writeJournal(deps.storage, journal);

  const applied: string[] = [];
  for (const entry of entries) {
    await applyEntry(root, entry, deps.contentStore, journal.transactionId);
    if (input.crashBetweenRenameAndJournal !== undefined && applied.length + 1 === input.crashBetweenRenameAndJournal) {
      // rename landed; the journal never records it — the unrecorded-
      // replacement window recovery must handle.
      throw new Error(APPLY_CRASH_SENTINEL);
    }
    entry.applied = true;
    applied.push(entry.path);
    await writeJournal(deps.storage, journal);
    if (input.crashAfterFiles !== undefined && applied.length === input.crashAfterFiles) {
      throw new Error(APPLY_CRASH_SENTINEL);
    }
  }

  journal.committed = true;
  await writeJournal(deps.storage, journal);
  return { applied, conflicts: [] };
}

/**
 * Three-way preflight: a path is clean when the disk still matches the base
 * (applyable) or already matches the target (no-op); anything else is a
 * conflict that names the expected base hash and the actual disk hash.
 */
export async function preflightThreeWay(input: ThreeWayInput): Promise<ConflictReport> {
  const root = await fs.realpath(input.root);
  const baseByPath = new Map(input.base.map((file) => [file.path, file]));
  const targetByPath = new Map(input.target.map((file) => [file.path, file]));
  const paths = [...new Set([...baseByPath.keys(), ...targetByPath.keys()])].sort();
  const conflicts: FileConflict[] = [];
  for (const relativePath of paths) {
    const current = await diskHash(root, relativePath);
    const targetHash = targetByPath.get(relativePath)?.hash ?? null;
    const baseHash = baseByPath.get(relativePath)?.hash ?? null;
    if (current === targetHash || current === baseHash) {
      continue;
    }
    conflicts.push({ path: relativePath, expected: baseHash, actual: current });
  }
  return { conflicts, clean: conflicts.length === 0 };
}

/** Delegated recovery entry point for engines constructed with storage + CAS. */
export async function recoverJournals(deps: ApplyDeps): Promise<RecoveryReport> {
  return recoverApplyJournals(deps.storage, deps.contentStore);
}
