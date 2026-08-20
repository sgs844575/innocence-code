/**
 * Integration fixtures for task-git tests: real temporary Git repositories
 * created through the Git CLI. Fixtures may use ANY git verb (init, config,
 * add, commit, mv, update-index...); the allowlist in src/git-process.ts only
 * constrains the adapter, never test setup.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach } from "vitest";

const execFileAsync = promisify(execFile);

/** Runs an arbitrary git command inside a fixture (never the adapter path). */
export async function gitExec(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout: stdout as string, stderr: stderr as string };
}

export async function tempDir(prefix = "innocence-task-git-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Recursive removal with retry/backoff: freshly created directories on
 * Windows can transiently fail with EBUSY/EPERM while antivirus or the
 * indexer still holds handles.
 */
export async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch {
      if (attempt === 4) {
        return; // best effort; temp dir leftovers are acceptable
      }
      await new Promise((resolve) => setTimeout(resolve, 75 * 2 ** attempt));
    }
  }
}

/** Per-test cleanup registry; runs after every test in the importing file. */
const pendingCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const cleanups = pendingCleanups.splice(0);
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

/** Tracks a fixture object with a cleanup() method for afterEach removal. */
export function track<T extends { cleanup: () => Promise<void> }>(fixture: T): T {
  pendingCleanups.push(() => fixture.cleanup());
  return fixture;
}

/** Tracks a bare directory for afterEach removal and returns it. */
export function trackDir(dir: string): string {
  pendingCleanups.push(() => removeDir(dir));
  return dir;
}

export async function writeRepoFile(root: string, relativePath: string, content: string | Uint8Array): Promise<void> {
  const absolute = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
}

export async function readRepoFile(root: string, relativePath: string): Promise<string> {
  return fs.readFile(path.join(root, ...relativePath.split("/")), "utf8");
}

export async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.stat(absolutePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export interface GitFixtureSpec {
  /** Files committed in the initial commit (plus automatic bases for dirty/deleted). */
  committed?: Record<string, string | Uint8Array>;
  /** Files written and `git add`-ed after the initial commit. */
  staged?: Record<string, string | Uint8Array>;
  /** Tracked files overwritten after the initial commit (auto-committed base first). */
  dirty?: Record<string, string | Uint8Array>;
  /** Files written without any git involvement. */
  untracked?: Record<string, string | Uint8Array>;
  /** Tracked files removed from the worktree (not from the index). */
  deleted?: string[];
  /** Extra raw setup steps (git mv, update-index, more commits...). */
  postSetup?: (root: string) => Promise<void>;
}

export interface GitFixture {
  root: string;
  cleanup: () => Promise<void>;
}

/**
 * Creates a real git repository in os.tmpdir() with `git init -b main`,
 * a deterministic identity, autocrlf disabled (byte-exact fixtures on every
 * machine), an initial commit, then the requested staged/dirty/untracked/
 * deleted state and any postSetup steps.
 */
export async function createGitFixture(spec: GitFixtureSpec = {}): Promise<GitFixture> {
  const root = await tempDir("innocence-git-fixture-");
  const cleanup = async (): Promise<void> => removeDir(root);

  try {
    await gitExec(root, ["init", "-b", "main"]);
    await gitExec(root, ["config", "user.name", "Fixture User"]);
    await gitExec(root, ["config", "user.email", "fixture@example.invalid"]);
    await gitExec(root, ["config", "core.autocrlf", "false"]);

    const initial: Record<string, string | Uint8Array> = { ...(spec.committed ?? {}) };
    for (const name of Object.keys(spec.dirty ?? {})) {
      initial[name] = `committed base of ${name}\n`;
    }
    for (const name of spec.deleted ?? []) {
      initial[name] = initial[name] ?? `committed base of ${name}\n`;
    }
    for (const [name, content] of Object.entries(initial)) {
      await writeRepoFile(root, name, content);
    }
    if (Object.keys(initial).length > 0) {
      await gitExec(root, ["add", "-A"]);
      await gitExec(root, ["commit", "-m", "fixture base"]);
    }

    const staged = Object.entries(spec.staged ?? {});
    for (const [name, content] of staged) {
      await writeRepoFile(root, name, content);
    }
    if (staged.length > 0) {
      await gitExec(root, ["add", ...staged.map(([name]) => name)]);
    }
    for (const [name, content] of Object.entries(spec.dirty ?? {})) {
      await writeRepoFile(root, name, content);
    }
    for (const [name, content] of Object.entries(spec.untracked ?? {})) {
      await writeRepoFile(root, name, content);
    }
    for (const name of spec.deleted ?? []) {
      await fs.rm(path.join(root, ...name.split("/")), { force: true });
    }

    await spec.postSetup?.(root);
  } catch (error) {
    await cleanup();
    throw error;
  }

  return { root, cleanup };
}

/** Raw porcelain v2 + index snapshot used for byte-identical comparisons. */
export async function readPorcelainAndIndex(root: string): Promise<string> {
  const porcelain = await gitExec(root, ["status", "--porcelain=v2", "-z", "--branch"]);
  const index = await gitExec(root, ["ls-files", "-s"]);
  const cached = await gitExec(root, ["diff", "--cached"]);
  return `${porcelain.stdout}\n--index--\n${index.stdout}\n--cached--\n${cached.stdout}`;
}

/** Index-only snapshot (ls-files -s + diff --cached); worktree changes excluded. */
export async function indexSnapshot(root: string): Promise<string> {
  const index = await gitExec(root, ["ls-files", "-s"]);
  const cached = await gitExec(root, ["diff", "--cached"]);
  return `${index.stdout}\n--cached--\n${cached.stdout}`;
}
