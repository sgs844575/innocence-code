/**
 * Task 3 step 4: worktree lifecycle — creation (detached, registered),
 * crash recovery (missing dir rebuild, healthy reuse, typed failures),
 * destroy (remove --force + prune, idempotent) and closeLease (no disk
 * effects).
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGitAdapter, GitProcessError, GitRecoveryError } from "../src/index.ts";
import {
  createGitFixture,
  fileExists,
  gitExec,
  readRepoFile,
  tempDir,
  track,
  trackDir,
  writeRepoFile,
} from "./fixtures.ts";

const sha256 = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

/** Map-backed content reader port (task-git itself has no CAS dependency). */
function mapReader(entries: Record<string, string | Uint8Array> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    put: (hash: string, content: string | Uint8Array) => store.set(hash, content),
    readContent: async (hash: string): Promise<Uint8Array> => {
      const content = store.get(hash);
      if (content === undefined) {
        throw new Error(`missing content for ${hash}`);
      }
      return typeof content === "string" ? new TextEncoder().encode(content) : content;
    },
  };
}

async function worktreePaths(root: string): Promise<string[]> {
  const list = await gitExec(root, ["worktree", "list", "--porcelain"]);
  return list.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}

async function canonical(value: string): Promise<string> {
  try {
    return path.join(await fs.realpath(path.dirname(value)), path.basename(value));
  } catch {
    return path.resolve(value);
  }
}

async function samePathListed(root: string, target: string): Promise<boolean> {
  const listed = await worktreePaths(root);
  const wanted = (await canonical(target)).toLowerCase();
  for (const entry of listed) {
    if ((await canonical(entry)).toLowerCase() === wanted) {
      return true;
    }
  }
  return false;
}

describe("createWorktree", () => {
  it("rejects worktree creation for a non-Git directory", async () => {
    const adapter = createGitAdapter();
    const root = await tempDir();
    await expect(adapter.createWorktree({ root, path: path.join(root, "wt") })).rejects.toThrow(
      "not a Git repository",
    );
  }, 30_000);

  it("creates a registered detached worktree at HEAD", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "a\n" } }));
    const head = (await gitExec(fixture.root, ["rev-parse", "HEAD"])).stdout.trim();
    const parent = trackDir(await tempDir("innocence-worktree-"));
    const worktreePath = path.join(parent, "wt");

    const lease = await createGitAdapter().createWorktree({ root: fixture.root, path: worktreePath });

    const toplevel = (await gitExec(fixture.root, ["rev-parse", "--show-toplevel"])).stdout.trim();
    expect(lease.repoRoot.replace(/\\/g, "/").toLowerCase()).toBe(toplevel.toLowerCase());
    expect((await canonical(lease.path)).toLowerCase()).toBe((await canonical(worktreePath)).toLowerCase());
    expect(lease.baseCommit).toBe(head);
    expect(lease.leaseId.length).toBeGreaterThan(0);
    expect(await samePathListed(fixture.root, lease.path)).toBe(true);

    const info = await createGitAdapter().detect(lease.path);
    expect(info.headCommit).toBe(head);
    expect(info.branch).toBeNull(); // detached
    const porcelain = await gitExec(lease.path, ["status", "--porcelain"]);
    expect(porcelain.stdout).toBe("");
  }, 60_000);

  it("creates from an explicit earlier base commit", async () => {
    const fixture = track(
      await createGitFixture({
        committed: { "a.txt": "first\n" },
        postSetup: async (root) => {
          await writeRepoFile(root, "a.txt", "second\n");
          await gitExec(root, ["add", "a.txt"]);
          await gitExec(root, ["commit", "-m", "second"]);
        },
      }),
    );
    const commits = (await gitExec(fixture.root, ["rev-list", "--reverse", "HEAD"])).stdout.trim().split("\n");
    const first = commits[0]!;
    const second = commits[1]!;
    expect(first).not.toBe(second);

    const parent = trackDir(await tempDir("innocence-worktree-"));
    const lease = await createGitAdapter().createWorktree({
      root: fixture.root,
      path: path.join(parent, "wt"),
      baseCommit: first,
    });
    expect(lease.baseCommit).toBe(first);
    expect(await readRepoFile(lease.path, "a.txt")).toBe("first\n");
  }, 60_000);

  it("rejects a non-empty existing path with a git error", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "a\n" } }));
    const parent = trackDir(await tempDir("innocence-worktree-"));
    const worktreePath = path.join(parent, "occupied");
    await fs.mkdir(worktreePath, { recursive: true });
    await writeRepoFile(worktreePath, "blocker.txt", "not empty\n");
    const error = await createGitAdapter()
      .createWorktree({ root: fixture.root, path: worktreePath })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProcessError);
    expect((error as Error).message).toMatch(/already exists|empty|worktree/i);
  }, 60_000);
});

describe("recoverWorktree", () => {
  it("rebuilds a missing worktree from the base commit and replays baseline + checkpoint", async () => {
    const fixture = track(
      await createGitFixture({
        committed: { "app.ts": "v1\n", "user.md": "user base\n" },
        dirty: { "user.md": "user notes\n" },
        untracked: { "scratch.txt": "scratch\n" },
      }),
    );
    const adapter = createGitAdapter();
    const baseline = await adapter.captureBaseline(fixture.root);
    const parent = trackDir(await tempDir("innocence-worktree-"));
    const worktreePath = path.join(parent, "wt");
    const lease = await adapter.createWorktree({ root: fixture.root, path: worktreePath });
    await adapter.overlayBaseline(lease, baseline);
    // subroute progress inside the worktree (the "last committed checkpoint")
    await writeRepoFile(lease.path, "app.ts", "v2\n");
    await writeRepoFile(lease.path, "feature.ts", "feature one\n");
    const reader = mapReader();
    reader.put(sha256("v2\n"), "v2\n");
    reader.put(sha256("feature one\n"), "feature one\n");

    // crash: the worktree directory is destroyed WITHOUT closeLease/destroy
    await fs.rm(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

    // restart: a FRESH adapter instance recovers
    const fresh = createGitAdapter();
    const recovered = await fresh.recoverWorktree({
      root: fixture.root,
      path: worktreePath,
      baseCommit: lease.baseCommit,
      baseline,
      checkpointFiles: [
        { path: "app.ts", hash: sha256("v2\n") },
        { path: "feature.ts", hash: sha256("feature one\n") },
      ],
      readContent: reader.readContent,
    });

    expect(path.resolve(recovered.path)).toBe(path.resolve(worktreePath));
    expect(await samePathListed(fixture.root, worktreePath)).toBe(true);
    expect(await readRepoFile(recovered.path, "app.ts")).toBe("v2\n");
    expect(await readRepoFile(recovered.path, "feature.ts")).toBe("feature one\n");
    expect(await readRepoFile(recovered.path, "user.md")).toBe("user notes\n"); // baseline replayed
    expect(await readRepoFile(recovered.path, "scratch.txt")).toBe("scratch\n");
  }, 120_000);

  it("reuses a healthy registered worktree without resetting it", async () => {
    const fixture = track(await createGitFixture({ committed: { "app.ts": "v1\n" } }));
    const adapter = createGitAdapter();
    const baseline = await adapter.captureBaseline(fixture.root);
    const parent = trackDir(await tempDir("innocence-worktree-"));
    const worktreePath = path.join(parent, "wt");
    const lease = await adapter.createWorktree({ root: fixture.root, path: worktreePath });
    await writeRepoFile(lease.path, "app.ts", "wip\n");
    await writeRepoFile(lease.path, "uncommitted-scratch.txt", "scratch\n");
    const reader = mapReader();
    reader.put(sha256("wip\n"), "wip\n");

    const recovered = await createGitAdapter().recoverWorktree({
      root: fixture.root,
      path: worktreePath,
      baseCommit: lease.baseCommit,
      baseline,
      checkpointFiles: [{ path: "app.ts", hash: sha256("wip\n") }],
      readContent: reader.readContent,
    });

    expect(await readRepoFile(recovered.path, "uncommitted-scratch.txt")).toBe("scratch\n"); // kept
    expect(await readRepoFile(recovered.path, "app.ts")).toBe("wip\n"); // checkpoint replayed
    // HEAD never moved (task-git never commits)
    const head = (await gitExec(recovered.path, ["rev-parse", "HEAD"])).stdout.trim();
    expect(head).toBe(lease.baseCommit);
  }, 120_000);

  it("throws a typed error for an unregistered non-empty directory", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "a\n" } }));
    const baseline = await createGitAdapter().captureBaseline(fixture.root);
    const stranger = trackDir(await tempDir("innocence-stranger-"));
    await writeRepoFile(stranger, "important.txt", "user data\n");

    const error = await createGitAdapter()
      .recoverWorktree({
        root: fixture.root,
        path: stranger,
        baseCommit: baseline.headCommit!,
        baseline,
        checkpointFiles: [],
        readContent: async () => {
          throw new Error("should not be reached");
        },
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitRecoveryError);
    expect((error as Error).message).toMatch(/not a registered/i);
    expect(await readRepoFile(stranger, "important.txt")).toBe("user data\n"); // untouched
  }, 60_000);

  it("recovers over an empty leftover directory", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "a\n" } }));
    const adapter = createGitAdapter();
    const baseline = await adapter.captureBaseline(fixture.root);
    const parent = trackDir(await tempDir("innocence-worktree-"));
    const worktreePath = path.join(parent, "wt");
    await fs.mkdir(worktreePath, { recursive: true }); // empty, unregistered leftover

    const lease = await adapter.recoverWorktree({
      root: fixture.root,
      path: worktreePath,
      baseCommit: baseline.headCommit!,
      baseline,
      checkpointFiles: [],
      readContent: async () => {
        throw new Error("no content expected");
      },
    });
    expect(await readRepoFile(lease.path, "a.txt")).toBe("a\n");
    expect(await samePathListed(fixture.root, worktreePath)).toBe(true);
  }, 60_000);

  it("fails recovery when the content reader returns mismatched bytes", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "a\n" } }));
    const adapter = createGitAdapter();
    const baseline = await adapter.captureBaseline(fixture.root);
    const parent = trackDir(await tempDir("innocence-worktree-"));
    const worktreePath = path.join(parent, "wt");
    const lease = await adapter.createWorktree({ root: fixture.root, path: worktreePath });
    const checkpointHash = sha256("checkpoint\n");

    await expect(
      createGitAdapter().recoverWorktree({
        root: fixture.root,
        path: worktreePath,
        baseCommit: lease.baseCommit,
        baseline,
        checkpointFiles: [{ path: "a.txt", hash: checkpointHash }],
        readContent: async () => new TextEncoder().encode("tampered bytes\n"),
      }),
    ).rejects.toBeInstanceOf(GitRecoveryError);
  }, 60_000);

  it("rejects recovery outside a Git repository", async () => {
    const dir = trackDir(await tempDir());
    const worktreePath = path.join(dir, "wt");
    await expect(
      createGitAdapter().recoverWorktree({
        root: dir,
        path: worktreePath,
        baseCommit: "0".repeat(40),
        baseline: { root: dir, headCommit: "0".repeat(40), branch: null, entries: [] },
        checkpointFiles: [],
        readContent: async () => new Uint8Array(),
      }),
    ).rejects.toThrow(/not a Git repository/i);
  }, 30_000);
});

describe("destroyWorktree", () => {
  it("removes the worktree and prunes its registration", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "a\n" } }));
    const parent = trackDir(await tempDir("innocence-worktree-"));
    const worktreePath = path.join(parent, "wt");
    const lease = await createGitAdapter().createWorktree({ root: fixture.root, path: worktreePath });
    expect(await samePathListed(fixture.root, worktreePath)).toBe(true);

    await createGitAdapter().destroyWorktree(lease);

    expect(await fileExists(worktreePath)).toBe(false);
    expect(await samePathListed(fixture.root, worktreePath)).toBe(false);
  }, 60_000);

  it("is idempotent for an already-removed worktree", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "a\n" } }));
    const parent = trackDir(await tempDir("innocence-worktree-"));
    const lease = await createGitAdapter().createWorktree({ root: fixture.root, path: path.join(parent, "wt") });
    const adapter = createGitAdapter();
    await adapter.destroyWorktree(lease);
    await expect(adapter.destroyWorktree(lease)).resolves.toBeUndefined();
  }, 60_000);
});

describe("closeLease", () => {
  it("releases nothing on disk", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "a\n" } }));
    const parent = trackDir(await tempDir("innocence-worktree-"));
    const worktreePath = path.join(parent, "wt");
    const lease = await createGitAdapter().createWorktree({ root: fixture.root, path: worktreePath });

    await createGitAdapter().closeLease(lease);

    expect(await fileExists(worktreePath)).toBe(true);
    expect(await samePathListed(fixture.root, worktreePath)).toBe(true);
  }, 60_000);

  it("rejects malformed leases", async () => {
    await expect(
      createGitAdapter().closeLease({ leaseId: "", repoRoot: "x", path: "y", baseCommit: "z" }),
    ).rejects.toThrow(/lease/i);
    await expect(
      createGitAdapter().closeLease({ leaseId: "id", repoRoot: "", path: "y", baseCommit: "z" }),
    ).rejects.toThrow(/lease/i);
  });
});
