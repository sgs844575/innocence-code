import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSecureStorage } from "@innocencecode/secure-storage-node";
import { createContentStore, sha256Bytes } from "../src/content-store.ts";
import { scanWorkspace } from "../src/scanner.ts";
import { createPatchEngine } from "../src/diff.ts";
import { APPLY_CRASH_SENTINEL } from "../src/apply.ts";
import { listJournals } from "../src/apply-journal.ts";

let base: string;

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-tws-journal-"));
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const encoder = new TextEncoder();
const hashOf = (text: string) => sha256Bytes(encoder.encode(text));

interface CrashScenario {
  name: string;
  crashAfterFiles: number | undefined;
}

/**
 * Builds a 3-file workspace in its AFTER state ("2" everywhere), snapshots
 * the BEFORE state ("1") into the CAS, and returns everything needed to run
 * a journaled reverse apply of the full transaction.
 */
async function threeFileTransaction() {
  const root = await fs.mkdtemp(path.join(base, "ws-"));
  const names = ["a.txt", "b.txt", "c.txt"];
  const contentOf = (name: string, generation: string) => `${name.slice(0, 1)}=${generation}\n`;
  for (const name of names) {
    await fs.writeFile(path.join(root, name), contentOf(name, "1"));
  }
  const storage = await openSecureStorage(path.join(base, `store-${Math.random().toString(36).slice(2)}`));
  const objects = createContentStore(storage);
  const before = await scanWorkspace(root);
  for (const file of before.files) {
    await objects.put(new Uint8Array(await fs.readFile(path.join(root, file.path))));
  }
  // the workspace moves to the "after" state; reverse apply will restore "1"
  for (const name of names) {
    await fs.writeFile(path.join(root, name), contentOf(name, "2"));
  }
  const after = await scanWorkspace(root);
  const engine = createPatchEngine({ storage, contentStore: objects });
  const patches = await engine.diff(before, after);
  return { root, storage, objects, engine, patches, contentOf };
}

const readFileText = async (root: string, name: string) => fs.readFile(path.join(root, name), "utf8");

describe("apply journal crash simulation and recovery", () => {
  const scenarios: CrashScenario[] = [
    { name: "crash after the 1st of 3 files", crashAfterFiles: 1 },
    { name: "crash after the 2nd of 3 files", crashAfterFiles: 2 },
  ];

  for (const scenario of scenarios) {
    it(`rolls every applied file back to pre-transaction bytes: ${scenario.name}`, async () => {
      const { root, storage, engine, patches } = await threeFileTransaction();

      await expect(
        engine.applyReverse({ root, patches, crashAfterFiles: scenario.crashAfterFiles }),
      ).rejects.toThrowError(APPLY_CRASH_SENTINEL);

      // the journal is on disk, uncommitted, with exactly N applied entries
      const journals = await listJournals(storage);
      expect(journals).toHaveLength(1);
      expect(journals[0]!.committed).toBe(false);
      expect(journals[0]!.entries.filter((entry) => entry.applied)).toHaveLength(scenario.crashAfterFiles!);
      // first N files hold restored ("1") content at the moment of death
      for (let index = 0; index < scenario.crashAfterFiles!; index += 1) {
        expect(await readFileText(root, `${"abc"[index]}.txt`)).toBe(`${"abc"[index]}=1\n`);
      }

      // a NEW engine instance on the same storage performs startup recovery
      const freshEngine = createPatchEngine({ storage, contentStore: createContentStore(storage) });
      const report = await freshEngine.recoverApplyJournals();
      const expectedRollback = patches
        .slice()
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .slice(0, scenario.crashAfterFiles)
        .map((patch) => patch.path);
      expect([...report.rolledBack].sort()).toEqual([...expectedRollback].sort());
      expect(report.completed).toEqual([]);

      // ALL files are back to pre-transaction bytes ("2" everywhere)
      for (const name of ["a.txt", "b.txt", "c.txt"]) {
        expect(await readFileText(root, name)).toBe(`${name.slice(0, 1)}=2\n`);
      }
      // the uncommitted journal is gone after rollback
      expect(await listJournals(storage)).toEqual([]);
    });
  }

  it("completes a provably-finished transaction (all desired present, marker missing)", async () => {
    const { root, storage, objects, patches } = await threeFileTransaction();

    // dies AFTER the last file was replaced but BEFORE the committed marker
    await expect(
      createPatchEngine({ storage, contentStore: objects })
        .applyReverse({ root, patches, crashAfterFiles: 3 }),
    ).rejects.toThrowError(APPLY_CRASH_SENTINEL);

    const journals = await listJournals(storage);
    expect(journals[0]!.entries.every((entry) => entry.applied)).toBe(true);
    expect(journals[0]!.committed).toBe(false);

    const report = await createPatchEngine({ storage, contentStore: objects }).recoverApplyJournals();
    expect(report.rolledBack).toEqual([]);
    expect(report.completed).toHaveLength(1);
    // desired ("1") hashes verified present: the restore is kept
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      expect(await readFileText(root, name)).toBe(`${name.slice(0, 1)}=1\n`);
    }
    // the recovery backfilled the committed marker
    const afterRecovery = await listJournals(storage);
    expect(afterRecovery).toHaveLength(1);
    expect(afterRecovery[0]!.committed).toBe(true);

    // a later recovery run cleans the committed journal
    const second = await createPatchEngine({ storage, contentStore: objects }).recoverApplyJournals();
    expect(second.inspected).toBe(1);
    expect(second.completed).toEqual([]);
    expect(second.rolledBack).toEqual([]);
    expect(await listJournals(storage)).toEqual([]);
  });

  it("keeps hashes authoritative: a corrupted desired file is NOT completed", async () => {
    const { root, storage, objects, patches } = await threeFileTransaction();
    await expect(
      createPatchEngine({ storage, contentStore: objects }).applyReverse({ root, patches, crashAfterFiles: 3 }),
    ).rejects.toThrowError(APPLY_CRASH_SENTINEL);
    // an outside edit lands between death and recovery
    await fs.writeFile(path.join(root, "c.txt"), "sabotage\n");

    const report = await createPatchEngine({ storage, contentStore: objects }).recoverApplyJournals();
    expect(report.completed).toEqual([]);
    // all three applied entries rolled back to pre-transaction bytes
    expect([...report.rolledBack].sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      expect(await readFileText(root, name)).toBe(`${name.slice(0, 1)}=2\n`);
    }
  });

  it("leaves no journal behind after a clean committed apply", async () => {
    const { root, storage, objects, patches } = await threeFileTransaction();
    const result = await createPatchEngine({ storage, contentStore: objects }).applyReverse({ root, patches });
    expect(result.conflicts).toEqual([]);
    const journals = await listJournals(storage);
    expect(journals).toHaveLength(1);
    expect(journals[0]!.committed).toBe(true);
    expect(journals[0]!.entries.every((entry) => entry.applied)).toBe(true);
  });

  it("backed-up content lands in the CAS under its sha256 key", async () => {
    const { root, storage, objects, patches } = await threeFileTransaction();
    await expect(
      createPatchEngine({ storage, contentStore: objects }).applyReverse({ root, patches, crashAfterFiles: 1 }),
    ).rejects.toThrowError(APPLY_CRASH_SENTINEL);
    const journals = await listJournals(storage);
    const first = journals[0]!.entries.find((entry) => entry.applied)!;
    expect(first.backupRef).toBe(hashOf("a=2\n")); // pre-transaction content of a.txt
    expect(await objects.has(first.backupRef!)).toBe(true);
    await createPatchEngine({ storage, contentStore: objects }).recoverApplyJournals();
  });
});
