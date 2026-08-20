// I1 (final review): the isolated/baseline multi-file apply runs under the
// durable apply journal. Proofs over REAL storage and a REAL git fixture:
//   1. SHAPE parity — task-git's ApplyJournalDto, task-core's mirror and
//      task-workspace's engine record are the same type (compile-time).
//   2. CRASH parity — a journal write failing mid-batch (exactly what a
//      process death leaves: earlier renames landed, journal uncommitted)
//      rolls every applied file back to pre-apply bytes through the SAME
//      repository surface the Electron bridge and CLI runtime call on
//      recovery (TaskRepository.recoverApplyJournals).
//   3. SERVICE wiring — task-core's applyAccepted leaves a committed journal
//      on disk (audit record), which recovery cleans up.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createGitAdapter, sha256, type ApplyJournalDto } from "@innocencecode/task-git";
import { openTaskRepository, type ApplyJournal } from "@innocencecode/task-workspace";
import { storeBackedApplyJournal, type TaskApplyJournalHook, type TaskApplyJournalRecord } from "@innocencecode/task-core";
import {
  collectStructuredOutput,
  createTaskCliAdapter,
  createTaskCliRuntime,
} from "@innocencecode/task-cli";

const execFileAsync = promisify(execFile);

// -- 1. compile-time shape parity -------------------------------------------
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
export type _JournalParityGitCore = AssertTrue<Eq<ApplyJournalDto, TaskApplyJournalRecord>>;
export type _JournalParityGitEngine = AssertTrue<Eq<ApplyJournalDto, ApplyJournal>>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return dir;
}

async function createGitFixture(files: Record<string, string>): Promise<string> {
  const root = await tempDir("ic-apply-journal-git-");
  const git = (args: string[]) => execFileAsync("git", args, { cwd: root, windowsHide: true });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Journal Fixture"]);
  await git(["config", "user.email", "journal@example.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), content, "utf8");
  }
  await git(["add", "-A"]);
  await git(["commit", "-m", "fixture base"]);
  return root;
}

async function readText(root: string, relativePath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(root, relativePath), "utf8");
  } catch {
    return null;
  }
}

describe("journaled apply (I1)", () => {
  it("rolls a mid-batch crashed apply back to pre-apply bytes through repository recovery", async () => {
    const base: Record<string, string> = { "a.txt": "base a\n", "b.txt": "base b\n", "c.txt": "base c\n" };
    const repo = await createGitFixture(base);
    const storageDir = await tempDir("ic-apply-journal-store-");
    const taskId = "journaled";
    const repository = await openTaskRepository(storageDir, taskId);

    const hook = storeBackedApplyJournal(
      {
        writeArtifact: async (_id: string, name: string, data: string) => {
          await repository.storage.storage.writeFileAtomic(name, data);
        },
        putObject: async (_id: string, bytes: Uint8Array) => (await repository.objects.put(bytes)).key,
      },
      taskId,
    );

    // The dying process: journal write #3 (after b.txt's rename) never lands.
    let writes = 0;
    const dying: TaskApplyJournalHook = {
      backup: hook.backup,
      write: async (journal) => {
        writes += 1;
        if (writes === 3) throw new Error("simulated process death after entry 2 rename");
        await hook.write(journal);
      },
    };

    const incoming: Record<string, string> = { "a.txt": "new a\n", "b.txt": "new b\n", "c.txt": "new c\n" };
    const contentByHash = new Map(Object.entries(incoming).map(([file, text]) => [sha256(new TextEncoder().encode(text)), file]));
    const git = createGitAdapter();
    await expect(
      git.applyAccepted({
        mode: "isolated",
        root: repo,
        files: Object.keys(base).map((file) => ({
          path: file,
          baseHash: sha256(new TextEncoder().encode(base[file]!)),
          incomingHash: sha256(new TextEncoder().encode(incoming[file]!)),
        })),
        readContent: async (hash) => {
          const file = contentByHash.get(hash);
          if (file === undefined) throw new Error(`no content for ${hash}`);
          return new TextEncoder().encode(incoming[file]!);
        },
        journal: dying,
      }),
    ).rejects.toThrow("simulated process death");

    // Mid-batch crash state: a + b applied (b is the unrecorded-replacement
    // window — rename landed, journal still says applied:false), c untouched.
    expect(await readText(repo, "a.txt")).toBe("new a\n");
    expect(await readText(repo, "b.txt")).toBe("new b\n");
    expect(await readText(repo, "c.txt")).toBe("base c\n");
    const journalsBefore = await repository.storage.storage.listDir("apply-journal");
    expect(journalsBefore).toHaveLength(1);

    // The SAME surface bridge.recoverTask / the CLI runtime call on recovery.
    const report = await repository.recoverApplyJournals();
    expect([...report.rolledBack].sort()).toEqual(["a.txt", "b.txt"]);
    expect(await readText(repo, "a.txt")).toBe("base a\n");
    expect(await readText(repo, "b.txt")).toBe("base b\n");
    expect(await readText(repo, "c.txt")).toBe("base c\n");
    // The journal is consumed; a second recovery is a no-op.
    const second = await repository.recoverApplyJournals();
    expect(second).toEqual({ inspected: 0, completed: [], rolledBack: [] });
  }, 120_000);

  it("service applyAccepted journals into the task storage and recovery cleans the audit record", async () => {
    const repo = await createGitFixture({ "a.txt": "committed\n" });
    const storageDir = await tempDir("ic-apply-journal-service-");
    const runtime = await createTaskCliRuntime({
      storageDir,
      agentWriter: async (task) => {
        await fs.writeFile(path.join(task.workspaceRoot, "a.txt"), "committed\nagent change\n", "utf8");
      },
    });
    const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });

    const task = await cli.start({ workspaceRoot: repo, mode: "isolated" });
    for (const hunk of await cli.listHunks(task.taskId, task.activeRouteId)) {
      await cli.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: hunk.ref, status: "accepted" });
    }
    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: false })).resolves.toBeUndefined();

    const applied = await cli.applyAccepted(task.taskId, task.activeRouteId);
    expect(applied.conflicts).toEqual([]);
    expect(await readText(repo, "a.txt")).toBe("committed\nagent change\n");

    // The committed journal stays on disk as the audit record until recovery.
    const journalsDir = path.join(storageDir, "tasks", task.taskId, "apply-journal");
    const journals = await fs.readdir(journalsDir);
    expect(journals).toHaveLength(1);
    const journal = JSON.parse(
      await fs.readFile(path.join(journalsDir, journals[0]!), "utf8"),
    ) as { committed: boolean; entries: { path: string; applied: boolean }[] };
    expect(journal.committed).toBe(true);
    expect(journal.entries.map((entry) => entry.path)).toEqual(["a.txt"]);

    const report = await (await openTaskRepository(storageDir, task.taskId)).recoverApplyJournals();
    expect(report.inspected).toBe(1);
    expect(report.rolledBack).toEqual([]);
    await expect(fs.readdir(journalsDir)).resolves.toHaveLength(0);
  }, 180_000);
});
