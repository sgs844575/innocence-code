/**
 * Durable apply journal.
 *
 * A multi-file apply first persists the whole transaction (id, workspace
 * root, per-file before-hash/backup-ref/desired-hash), then replaces files
 * one by one updating the journal after each, and finally flips
 * `committed` to true. A process death at any point leaves a journal on
 * disk that exactly describes the interrupted transaction; recovery either
 * completes a provably-finished commit or rolls every applied file back to
 * its pre-transaction bytes from the backup refs.
 */
import fs from "node:fs/promises";
import type { SecureStorage } from "@innocencecode/secure-storage-node";
import type { ContentStore } from "./content-store.ts";
import { diskHash, resolveWorkspaceFile } from "./scanner.ts";

export interface ApplyJournalEntry {
  /** Workspace-relative path. */
  path: string;
  /** Hash of the on-disk content when the transaction started (null: absent). */
  beforeHash: string | null;
  /** CAS key of the backed-up pre-transaction content (null: file was absent). */
  backupRef: string | null;
  /** Hash the file must have after this transaction (null: file must be absent). */
  desiredHash: string | null;
  applied: boolean;
}

export interface ApplyJournal {
  transactionId: string;
  createdAt: string;
  root: string;
  committed: boolean;
  entries: ApplyJournalEntry[];
}

export interface RecoveryReport {
  /** Number of journals found on disk (committed ones are cleaned up). */
  inspected: number;
  /** Transaction ids proven complete: committed marker was backfilled. */
  completed: string[];
  /** Workspace paths rolled back to pre-transaction bytes. */
  rolledBack: string[];
}

const JOURNAL_DIR = "apply-journal";

function journalFile(transactionId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(transactionId)) {
    throw new Error(`apply journal: invalid transaction id: ${JSON.stringify(transactionId)}`);
  }
  return `${JOURNAL_DIR}/${transactionId}.json`;
}

/** Persists the journal atomically (temp write + fsync + rename). */
export async function writeJournal(storage: SecureStorage, journal: ApplyJournal): Promise<void> {
  await storage.writeFileAtomic(journalFile(journal.transactionId), JSON.stringify(journal));
}

export async function readJournal(storage: SecureStorage, transactionId: string): Promise<ApplyJournal | null> {
  try {
    const raw = await storage.readTextFile(journalFile(transactionId));
    return JSON.parse(raw) as ApplyJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function deleteJournal(storage: SecureStorage, transactionId: string): Promise<void> {
  await storage.deleteFile(journalFile(transactionId));
}

/** All journals on disk, oldest first. Corrupt files are skipped. */
export async function listJournals(storage: SecureStorage): Promise<ApplyJournal[]> {
  let names: string[] = [];
  try {
    names = await storage.listDir(JOURNAL_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const journals: ApplyJournal[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      const raw = await storage.readTextFile(`${JOURNAL_DIR}/${name}`);
      journals.push(JSON.parse(raw) as ApplyJournal);
    } catch {
      // A journal we cannot parse cannot drive recovery; leave it for humans.
    }
  }
  journals.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return journals;
}

async function restoreBackup(root: string, entry: ApplyJournalEntry, contentStore: ContentStore): Promise<void> {
  const target = resolveWorkspaceFile(root, entry.path);
  if (entry.backupRef === null) {
    await fs.rm(target, { force: true });
    return;
  }
  const backup = await contentStore.get(entry.backupRef);
  const temp = `${target}.rollback-${Math.random().toString(36).slice(2)}.tmp`;
  const handle = await fs.open(temp, "w");
  try {
    await handle.writeFile(backup);
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

/**
 * Recovers interrupted transactions:
 *
 * - committed journals are deleted (transaction already finished);
 * - an uncommitted journal whose entries are ALL applied and whose files ALL
 *   match their desired hashes is proven complete: the committed marker is
 *   backfilled and the journal removed;
 * - anything else is rolled back: every APPLIED path is restored from its
 *   backup ref (or deleted when it had no pre-transaction content). Entries
 *   that were never RECORDED as applied are rolled back too when the disk
 *   content is conclusively the desired content — the process died between
 *   the atomic rename and the journal write, and desired content on disk is
 *   not pre-transaction content (the journal guarantees desiredHash differs
 *   from beforeHash for every entry).
 *
 * Staleness is proven by content hashes, never by wall-clock timeouts.
 */
export async function recoverApplyJournals(
  storage: SecureStorage,
  contentStore: ContentStore,
): Promise<RecoveryReport> {
  const journals = await listJournals(storage);
  const report: RecoveryReport = { inspected: journals.length, completed: [], rolledBack: [] };
  for (const journal of journals) {
    if (journal.committed) {
      await deleteJournal(storage, journal.transactionId);
      continue;
    }
    const allApplied = journal.entries.every((entry) => entry.applied);
    const allDesiredPresent =
      allApplied &&
      (await Promise.all(
        journal.entries.map((entry) => diskHash(journal.root, entry.path)),
      )).every((hash, index) => hash === journal.entries[index]!.desiredHash);

    if (allApplied && allDesiredPresent) {
      // Proven complete: backfill the committed marker the dead process never
      // wrote. The journal stays on disk as the audit record; a later
      // recovery run (see the committed branch above) cleans it up.
      await writeJournal(storage, { ...journal, committed: true });
      report.completed.push(journal.transactionId);
      continue;
    }

    for (const entry of [...journal.entries].reverse()) {
      if (!entry.applied) {
        // Unrecorded-replacement window: the rename/unlink landed but the
        // journal write did not. diskHash === desiredHash (and differs from
        // beforeHash) proves the file is NOT at its pre-transaction bytes,
        // so it must be rolled back like any applied entry.
        const current = await diskHash(journal.root, entry.path);
        const replacedUnrecorded = current !== entry.beforeHash && current === entry.desiredHash;
        if (!replacedUnrecorded) {
          continue; // untouched: still at pre-transaction bytes
        }
      }
      await restoreBackup(journal.root, entry, contentStore);
      report.rolledBack.push(entry.path);
    }
    await deleteJournal(storage, journal.transactionId);
  }
  return report;
}
