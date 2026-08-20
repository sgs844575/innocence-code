/**
 * Task 3 step 5: three-way preflight and apply into the ORIGINAL workspace.
 * - baseline (default) mode: verify expected hashes, then reverse-apply the
 *   task increments; any mismatch writes nothing.
 * - isolated mode: compare base/current/incoming per file before writing the
 *   accepted patch; any divergence writes nothing.
 * After a successful apply the index must be byte-identical
 * (git ls-files -s + git diff --cached).
 * Also drives the flagship kill/restart -> continue -> final apply loop.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGitAdapter } from "../src/index.ts";
import {
  createGitFixture,
  fileExists,
  gitExec,
  indexSnapshot,
  readRepoFile,
  tempDir,
  track,
  trackDir,
  writeRepoFile,
} from "./fixtures.ts";

const sha256 = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Map-backed content reader port. */
function mapReader(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    put: (hash: string, content: string) => store.set(hash, content),
    readContent: async (hash: string): Promise<Uint8Array> => {
      const content = store.get(hash);
      if (content === undefined) {
        throw new Error(`missing content for ${hash}`);
      }
      return enc(content);
    },
  };
}

describe("isolated mode apply", () => {
  it("applies accepted content into the original workspace and leaves the index untouched", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "1\n" } }));
    const before = await indexSnapshot(fixture.root);
    const reader = mapReader();
    const incomingHash = sha256("2\n");
    reader.put(incomingHash, "2\n");

    const result = await createGitAdapter().applyAccepted({
      mode: "isolated",
      root: fixture.root,
      files: [{ path: "a.txt", baseHash: sha256("1\n"), incomingHash }],
      readContent: reader.readContent,
    });

    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual(["a.txt"]);
    expect(await readRepoFile(fixture.root, "a.txt")).toBe("2\n");
    expect(await indexSnapshot(fixture.root)).toEqual(before);
  }, 60_000);

  it("writes new files as untracked without touching the index", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "1\n" } }));
    const before = await indexSnapshot(fixture.root);
    const reader = mapReader();
    const createdHash = sha256("created\n");
    reader.put(createdHash, "created\n");

    const result = await createGitAdapter().applyAccepted({
      mode: "isolated",
      root: fixture.root,
      files: [{ path: "created.txt", baseHash: null, incomingHash: createdHash }],
      readContent: reader.readContent,
    });

    expect(result.applied).toEqual(["created.txt"]);
    expect(await readRepoFile(fixture.root, "created.txt")).toBe("created\n");
    const index = await gitExec(fixture.root, ["ls-files", "-s"]);
    expect(index.stdout).not.toContain("created.txt"); // still untracked
    expect(await indexSnapshot(fixture.root)).toEqual(before);
  }, 60_000);

  it("deletes files only in the worktree; the index keeps the entry", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "1\n", "b.txt": "b\n" } }));
    const before = await indexSnapshot(fixture.root);

    const result = await createGitAdapter().applyAccepted({
      mode: "isolated",
      root: fixture.root,
      files: [
        { path: "a.txt", baseHash: sha256("1\n"), incomingHash: null },
        { path: "b.txt", baseHash: sha256("b\n"), incomingHash: sha256("b2\n") },
      ],
      readContent: async (hash) => {
        expect(hash).toBe(sha256("b2\n"));
        return enc("b2\n");
      },
    });

    expect(result.applied.sort()).toEqual(["a.txt", "b.txt"]);
    expect(await fileExists(path.join(fixture.root, "a.txt"))).toBe(false);
    expect(await readRepoFile(fixture.root, "b.txt")).toBe("b2\n");
    const index = await gitExec(fixture.root, ["ls-files", "-s"]);
    expect(index.stdout).toContain("a.txt"); // index untouched
    expect(await indexSnapshot(fixture.root)).toEqual(before);
  }, 60_000);

  it("conflicts on external concurrent modification and writes nothing", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "1\n", "b.txt": "b\n" } }));
    const reader = mapReader();
    const hash2 = sha256("2\n");
    const hashB2 = sha256("b2\n");
    reader.put(hash2, "2\n");
    reader.put(hashB2, "b2\n");

    // external concurrent modification of a.txt AFTER the base was taken
    await writeRepoFile(fixture.root, "a.txt", "external edit\n");

    const result = await createGitAdapter().applyAccepted({
      mode: "isolated",
      root: fixture.root,
      files: [
        { path: "a.txt", baseHash: sha256("1\n"), incomingHash: hash2 },
        { path: "b.txt", baseHash: sha256("b\n"), incomingHash: hashB2 },
      ],
      readContent: reader.readContent,
    });

    expect(result.applied).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.path).toBe("a.txt");
    expect(result.conflicts[0]!.expected).toBe(sha256("1\n"));
    expect(result.conflicts[0]!.actual).toBe(sha256("external edit\n"));
    // all-or-nothing: the clean b.txt write never happened either
    expect(await readRepoFile(fixture.root, "a.txt")).toBe("external edit\n");
    expect(await readRepoFile(fixture.root, "b.txt")).toBe("b\n");
  }, 60_000);

  it("treats a file that already matches the incoming content as clean", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "1\n" } }));
    await writeRepoFile(fixture.root, "a.txt", "2\n"); // already applied externally
    const report = await createGitAdapter().preflightApply({
      mode: "isolated",
      root: fixture.root,
      files: [{ path: "a.txt", baseHash: sha256("1\n"), incomingHash: sha256("2\n") }],
      readContent: async () => enc("2\n"),
    });
    expect(report.clean).toBe(true);
    expect(report.conflicts).toEqual([]);
  }, 60_000);

  it("conflicts when the base says absent but the file now exists", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "1\n" } }));
    await writeRepoFile(fixture.root, "new.txt", "appeared meanwhile\n");
    const report = await createGitAdapter().preflightApply({
      mode: "isolated",
      root: fixture.root,
      files: [{ path: "new.txt", baseHash: null, incomingHash: sha256("incoming\n") }],
      readContent: async () => enc("incoming\n"),
    });
    expect(report.clean).toBe(false);
    expect(report.conflicts[0]!.expected).toBeNull();
    expect(report.conflicts[0]!.actual).toBe(sha256("appeared meanwhile\n"));
  }, 60_000);
});

describe("baseline mode reverse apply", () => {
  it("restores task increments to the checkpoint state after verifying expected hashes", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "checkpoint\n" } }));
    const before = await indexSnapshot(fixture.root);
    // task increments: modified a.txt and created task.txt
    await writeRepoFile(fixture.root, "a.txt", "increment\n");
    await writeRepoFile(fixture.root, "task.txt", "scratch\n");

    const result = await createGitAdapter().applyAccepted({
      mode: "baseline",
      root: fixture.root,
      files: [
        { path: "a.txt", expectedHash: sha256("increment\n"), restoreHash: sha256("checkpoint\n") },
        { path: "task.txt", expectedHash: sha256("scratch\n"), restoreHash: null },
      ],
      readContent: async (hash) => {
        expect(hash).toBe(sha256("checkpoint\n"));
        return enc("checkpoint\n");
      },
    });

    expect(result.conflicts).toEqual([]);
    expect(result.applied.sort()).toEqual(["a.txt", "task.txt"]);
    expect(await readRepoFile(fixture.root, "a.txt")).toBe("checkpoint\n");
    expect(await fileExists(path.join(fixture.root, "task.txt"))).toBe(false);
    expect(await indexSnapshot(fixture.root)).toEqual(before);
  }, 60_000);

  it("writes nothing when any expected hash mismatches", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "checkpoint\n" } }));
    await writeRepoFile(fixture.root, "a.txt", "increment\n");
    await writeRepoFile(fixture.root, "task.txt", "scratch\n");
    // external tampering AFTER the increments were recorded
    await writeRepoFile(fixture.root, "a.txt", "TAMPER\n");

    const result = await createGitAdapter().applyAccepted({
      mode: "baseline",
      root: fixture.root,
      files: [
        { path: "a.txt", expectedHash: sha256("increment\n"), restoreHash: sha256("checkpoint\n") },
        { path: "task.txt", expectedHash: sha256("scratch\n"), restoreHash: null },
      ],
      readContent: async () => enc("checkpoint\n"),
    });

    expect(result.applied).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.path).toBe("a.txt");
    expect(result.conflicts[0]!.actual).toBe(sha256("TAMPER\n"));
    // nothing was touched: tampered file AND the untouched increment survive
    expect(await readRepoFile(fixture.root, "a.txt")).toBe("TAMPER\n");
    expect(await readRepoFile(fixture.root, "task.txt")).toBe("scratch\n");
  }, 60_000);
});

describe("preflightApply", () => {
  it("reports exactly what applyAccepted would conflict on, without writing", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "1\n" } }));
    await writeRepoFile(fixture.root, "a.txt", "external edit\n");
    const input = {
      mode: "isolated" as const,
      root: fixture.root,
      files: [{ path: "a.txt", baseHash: sha256("1\n"), incomingHash: sha256("2\n") }],
      readContent: async () => enc("2\n"),
    };
    const report = await createGitAdapter().preflightApply(input);
    expect(report.clean).toBe(false);
    expect(report.conflicts[0]!.path).toBe("a.txt");
    // no writes happened
    expect(await readRepoFile(fixture.root, "a.txt")).toBe("external edit\n");
  }, 60_000);

  it("rejects applying outside a Git repository", async () => {
    const dir = trackDir(await tempDir());
    await expect(
      createGitAdapter().preflightApply({
        mode: "isolated",
        root: dir,
        files: [{ path: "a.txt", baseHash: null, incomingHash: sha256("x\n") }],
        readContent: async () => enc("x\n"),
      }),
    ).rejects.toThrow(/not a Git repository/i);
  }, 30_000);

  it("refuses writes that target .git", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "1\n" } }));
    await expect(
      createGitAdapter().applyAccepted({
        mode: "isolated",
        root: fixture.root,
        files: [{ path: ".git/index", baseHash: null, incomingHash: sha256("evil\n") }],
        readContent: async () => enc("evil\n"),
      }),
    ).rejects.toThrow(/\.git/);
    expect(await indexSnapshot(fixture.root)).toContain("--cached--"); // repo still healthy
  }, 30_000);
});

describe("kill/restart loop (subroute round, crash, continue, final apply)", () => {
  it("survives an abandoned lease, keeps running, and finally applies into the original workspace", async () => {
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

    // open the isolated task workspace
    const lease = await adapter.createWorktree({ root: fixture.root, path: worktreePath });
    await adapter.overlayBaseline(lease, baseline);

    // subroute round 1 inside the worktree
    await writeRepoFile(lease.path, "app.ts", "v2\n");
    await writeRepoFile(lease.path, "feature.ts", "feature one\n");
    const reader = mapReader();
    reader.put(sha256("v2\n"), "v2\n");
    reader.put(sha256("feature one\n"), "feature one\n");
    reader.put(sha256("v3\n"), "v3\n");
    const checkpoint1 = [
      { path: "app.ts", hash: sha256("v2\n") },
      { path: "feature.ts", hash: sha256("feature one\n") },
    ];

    // KILL: the lease is abandoned (no closeLease, worktree dir lost entirely)
    await fs.rm(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

    // RESTART with a fresh adapter instance; recovery rebuilds and replays checkpoint 1
    const adapter2 = createGitAdapter();
    const recovered = await adapter2.recoverWorktree({
      root: fixture.root,
      path: worktreePath,
      baseCommit: lease.baseCommit,
      baseline,
      checkpointFiles: checkpoint1,
      readContent: reader.readContent,
    });
    expect(await readRepoFile(recovered.path, "app.ts")).toBe("v2\n");
    expect(await readRepoFile(recovered.path, "feature.ts")).toBe("feature one\n");
    expect(await readRepoFile(recovered.path, "user.md")).toBe("user notes\n");

    // continue running: round 2 produces a new checkpoint
    await writeRepoFile(recovered.path, "app.ts", "v3\n");
    const checkpoint2 = [
      { path: "app.ts", hash: sha256("v3\n") },
      { path: "feature.ts", hash: sha256("feature one\n") },
    ];
    // a second kill, this time the directory survives but the process died
    const adapter3 = createGitAdapter();
    const recovered2 = await adapter3.recoverWorktree({
      root: fixture.root,
      path: worktreePath,
      baseCommit: lease.baseCommit,
      baseline,
      checkpointFiles: checkpoint2,
      readContent: reader.readContent,
    });
    expect(await readRepoFile(recovered2.path, "app.ts")).toBe("v3\n");

    // FINAL APPLY: accepted content lands in the ORIGINAL workspace, whose
    // files are still at their baseline state.
    const indexBefore = await indexSnapshot(fixture.root);
    const result = await adapter3.applyAccepted({
      mode: "isolated",
      root: fixture.root,
      files: [
        { path: "app.ts", baseHash: sha256("v1\n"), incomingHash: sha256("v3\n") },
        { path: "feature.ts", baseHash: null, incomingHash: sha256("feature one\n") },
      ],
      readContent: reader.readContent,
    });
    expect(result.conflicts).toEqual([]);
    expect(result.applied.sort()).toEqual(["app.ts", "feature.ts"]);
    expect(await readRepoFile(fixture.root, "app.ts")).toBe("v3\n");
    expect(await readRepoFile(fixture.root, "feature.ts")).toBe("feature one\n");
    // user's own uncommitted work survived and the index never moved
    expect(await readRepoFile(fixture.root, "user.md")).toBe("user notes\n");
    expect(await readRepoFile(fixture.root, "scratch.txt")).toBe("scratch\n");
    expect(await indexSnapshot(fixture.root)).toBe(indexBefore); // index identical despite worktree changes

    // teardown: only explicit task deletion destroys the worktree
    await adapter3.destroyWorktree(recovered2);
    expect(await fileExists(worktreePath)).toBe(false);
  }, 180_000);
});
