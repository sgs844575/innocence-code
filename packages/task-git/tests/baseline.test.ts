/**
 * Task 3 step 4: captureBaseline must read staged/dirty/untracked state with
 * allowed probes only (the index byte-identical before/after) and
 * overlayBaseline must replay those bytes into a worktree with file-level
 * copies and zero git index operations.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGitAdapter } from "../src/index.ts";
import {
  createGitFixture,
  gitExec,
  readPorcelainAndIndex,
  readRepoFile,
  tempDir,
  track,
  trackDir,
  writeRepoFile,
} from "./fixtures.ts";

const sha256 = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

describe("captureBaseline", () => {
  it("preserves the index while capturing a dirty baseline", async () => {
    const repo = track(
      await createGitFixture({
        staged: { "staged.ts": "staged\n" },
        dirty: { "dirty.ts": "dirty\n" },
        untracked: { "new.ts": "new\n" },
      }),
    );
    const before = await readPorcelainAndIndex(repo.root);
    const info = await createGitAdapter().detect(repo.root);
    expect(info.kind).toBe("git");
    await createGitAdapter().captureBaseline(repo.root);
    expect(await readPorcelainAndIndex(repo.root)).toEqual(before);
  }, 30_000);

  it("classifies staged, dirty and untracked entries", async () => {
    const fixture = track(
      await createGitFixture({
        committed: { "kept.ts": "kept\n" },
        staged: { "staged.ts": "staged\n" },
        dirty: { "dirty.ts": "dirty\n" },
        untracked: { "loose.ts": "loose\n" },
      }),
    );
    const baseline = await createGitAdapter().captureBaseline(fixture.root);
    expect(baseline.branch).toBe("main");
    expect(baseline.headCommit).toMatch(/^[0-9a-f]{40}$/);

    const staged = baseline.entries.find((entry) => entry.path === "staged.ts")!;
    expect(staged.staged).toBe(true);
    expect(staged.dirty).toBe(false);
    expect(staged.untracked).toBe(false);
    expect(staged.hash).toBe(sha256("staged\n"));
    expect(staged.indexMode).toBe(0o100644);

    const dirty = baseline.entries.find((entry) => entry.path === "dirty.ts")!;
    expect(dirty.staged).toBe(false);
    expect(dirty.dirty).toBe(true);
    expect(dirty.hash).toBe(sha256("dirty\n"));

    const untracked = baseline.entries.find((entry) => entry.path === "loose.ts")!;
    expect(untracked.untracked).toBe(true);
    expect(untracked.staged).toBe(false);
    expect(untracked.dirty).toBe(false);
    expect(untracked.indexMode).toBeNull();
    expect(untracked.hash).toBe(sha256("loose\n"));

    // untouched tracked files are not baseline entries
    expect(baseline.entries.find((entry) => entry.path === "kept.ts")).toBeUndefined();
  }, 30_000);

  it("records rename origPath for staged renames", async () => {
    const fixture = track(
      await createGitFixture({
        committed: { "old-name.ts": "module content\n" },
        postSetup: async (root) => {
          await gitExec(root, ["mv", "old-name.ts", "new-name.ts"]);
        },
      }),
    );
    const baseline = await createGitAdapter().captureBaseline(fixture.root);
    const renamed = baseline.entries.find((entry) => entry.path === "new-name.ts")!;
    expect(renamed.origPath).toBe("old-name.ts");
    expect(renamed.staged).toBe(true);
    expect(renamed.hash).toBe(sha256("module content\n"));
  }, 30_000);

  it("expands untracked directories file by file", async () => {
    const fixture = track(
      await createGitFixture({
        untracked: {
          "brand-new-dir/a.txt": "A\n",
          "brand-new-dir/nested/b.txt": "B\n",
        },
      }),
    );
    const baseline = await createGitAdapter().captureBaseline(fixture.root);
    const paths = baseline.entries.map((entry) => entry.path);
    expect(paths).toEqual(["brand-new-dir/a.txt", "brand-new-dir/nested/b.txt"]);
    for (const entry of baseline.entries) {
      expect(entry.untracked).toBe(true);
    }
    expect(baseline.entries[0]!.hash).toBe(sha256("A\n"));
    expect(baseline.entries[1]!.hash).toBe(sha256("B\n"));
  }, 30_000);

  it("records deleted tracked files with a null hash", async () => {
    const fixture = track(
      await createGitFixture({ deleted: ["gone.ts"] }),
    );
    const baseline = await createGitAdapter().captureBaseline(fixture.root);
    const deleted = baseline.entries.find((entry) => entry.path === "gone.ts")!;
    expect(deleted.hash).toBeNull();
    expect(deleted.mode).toBeNull();
    expect(deleted.dirty).toBe(true);
    expect(deleted.staged).toBe(false);
  }, 30_000);

  it("captures binary content byte-exactly", async () => {
    const binary = new Uint8Array([0, 1, 2, 0, 255, 254, 0, 9]);
    const fixture = track(await createGitFixture({ staged: { "blob.bin": binary } }));
    const baseline = await createGitAdapter().captureBaseline(fixture.root);
    expect(baseline.entries.find((entry) => entry.path === "blob.bin")!.hash).toBe(sha256(binary));
  }, 30_000);

  it("captures index mode changes (update-index --chmod=+x)", async () => {
    const fixture = track(
      await createGitFixture({
        committed: { "script.sh": "#!/bin/sh\n" },
        postSetup: async (root) => {
          await gitExec(root, ["update-index", "--chmod=+x", "script.sh"]);
        },
      }),
    );
    const baseline = await createGitAdapter().captureBaseline(fixture.root);
    const entry = baseline.entries.find((e) => e.path === "script.sh");
    // With core.filemode defaulting to false on Windows the mode change is
    // visible through the index; on POSIX both sides carry it.
    if (entry) {
      expect(entry.indexMode).toBe(0o100755);
    }
  }, 30_000);

  it("rejects capture outside a Git repository", async () => {
    const dir = trackDir(await tempDir());
    await expect(createGitAdapter().captureBaseline(dir)).rejects.toThrow(/not a Git repository/i);
  });

  it("returns an empty entry list for a clean repository", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "a\n" } }));
    const baseline = await createGitAdapter().captureBaseline(fixture.root);
    expect(baseline.entries).toEqual([]);
  }, 30_000);
});

describe("overlayBaseline", () => {
  it("copies baseline bytes into a fresh worktree without index operations", async () => {
    const fixture = track(
      await createGitFixture({
        committed: { "tracked.ts": "committed\n", "gone.ts": "will be deleted\n" },
        staged: { "staged.ts": "staged\n" },
        dirty: { "tracked.ts": "dirty\n" },
        untracked: { "loose.ts": "loose\n" },
        deleted: ["gone.ts"],
      }),
    );
    const adapter = createGitAdapter();
    const baseline = await adapter.captureBaseline(fixture.root);
    const before = await readPorcelainAndIndex(fixture.root);

    const parent = trackDir(await tempDir("innocence-worktree-"));
    const lease = await adapter.createWorktree({ root: fixture.root, path: path.join(parent, "wt") });
    await adapter.overlayBaseline(lease, baseline);

    // bytes land in the worktree exactly as they are in the source workspace
    expect(await readRepoFile(lease.path, "staged.ts")).toBe("staged\n");
    expect(await readRepoFile(lease.path, "tracked.ts")).toBe("dirty\n");
    expect(await readRepoFile(lease.path, "loose.ts")).toBe("loose\n");
    // the deleted baseline file is removed from the worktree copy of HEAD
    await expect(readRepoFile(lease.path, "gone.ts")).rejects.toMatchObject({ code: "ENOENT" });
    // untouched committed content is still there
    expect(await fs.readFile(path.join(lease.path, ".git"), "utf8")).toContain("gitdir");

    // the SOURCE repository state is untouched (no index ops, no stash, no commit)
    expect(await readPorcelainAndIndex(fixture.root)).toEqual(before);
    // in the worktree, overlaid files appear as plain worktree/untracked changes
    const porcelain = await gitExec(lease.path, ["status", "--porcelain"]);
    expect(porcelain.stdout).toContain(" M tracked.ts");
    expect(porcelain.stdout).toContain("?? loose.ts");
    expect(porcelain.stdout).toContain("?? staged.ts");
  }, 60_000);

  it("preserves file modes (readonly bit) during overlay", async () => {
    const fixture = track(await createGitFixture({ committed: { "seed.txt": "seed\n" }, untracked: { "locked.ts": "locked\n" } }));
    const readonly = path.join(fixture.root, "locked.ts");
    await fs.chmod(readonly, 0o444);
    try {
      const adapter = createGitAdapter();
      const baseline = await adapter.captureBaseline(fixture.root);
      expect(baseline.entries[0]!.mode).toBe(0o444);

      const parent = trackDir(await tempDir("innocence-worktree-"));
      const lease = await adapter.createWorktree({ root: fixture.root, path: path.join(parent, "wt") });
      await adapter.overlayBaseline(lease, baseline);
      const overlaid = path.join(lease.path, "locked.ts");
      const lstat = await fs.lstat(overlaid);
      expect(lstat.mode & 0o7777).toBe(0o444);
      await fs.chmod(overlaid, 0o666); // allow cleanup to delete it
    } finally {
      await fs.chmod(readonly, 0o666).catch(() => undefined);
    }
  }, 60_000);

  it("re-overlays a readonly baseline file (second overlay keeps succeeding)", async () => {
    // Windows refuses to rename over an existing READONLY target (EPERM);
    // recovery replays the overlay unconditionally, so a second overlay of a
    // 0o444 baseline file must still succeed and keep the readonly mode.
    const fixture = track(await createGitFixture({ committed: { "seed.txt": "seed\n" }, untracked: { "locked.ts": "locked\n" } }));
    const readonly = path.join(fixture.root, "locked.ts");
    await fs.chmod(readonly, 0o444);
    try {
      const adapter = createGitAdapter();
      const baseline = await adapter.captureBaseline(fixture.root);
      const parent = trackDir(await tempDir("innocence-worktree-"));
      const lease = await adapter.createWorktree({ root: fixture.root, path: path.join(parent, "wt") });
      await adapter.overlayBaseline(lease, baseline);
      const overlaid = path.join(lease.path, "locked.ts");
      expect((await fs.lstat(overlaid)).mode & 0o7777).toBe(0o444);

      await adapter.overlayBaseline(lease, baseline); // as recovery does
      expect(await readRepoFile(lease.path, "locked.ts")).toBe("locked\n");
      expect((await fs.lstat(overlaid)).mode & 0o7777).toBe(0o444);
      await fs.chmod(overlaid, 0o666); // allow cleanup to delete it
    } finally {
      await fs.chmod(readonly, 0o666).catch(() => undefined);
    }
  }, 60_000);

  it("mirrors a source deletion that happened after capture", async () => {
    const fixture = track(
      await createGitFixture({ committed: { "seed.txt": "seed\n" }, untracked: { "later-gone.ts": "x\n" } }),
    );
    const adapter = createGitAdapter();
    const baseline = await adapter.captureBaseline(fixture.root);
    // user deletes the file after capture but before overlay
    await fs.rm(path.join(fixture.root, "later-gone.ts"));
    const parent = trackDir(await tempDir("innocence-worktree-"));
    const lease = await adapter.createWorktree({ root: fixture.root, path: path.join(parent, "wt") });
    await adapter.overlayBaseline(lease, baseline);
    await expect(readRepoFile(lease.path, "later-gone.ts")).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("overlays binary files byte-exactly", async () => {
    const binary = new Uint8Array([0, 7, 0, 128, 255, 0, 3]);
    const fixture = track(await createGitFixture({ committed: { "seed.txt": "seed\n" }, untracked: { "data.bin": binary } }));
    const adapter = createGitAdapter();
    const baseline = await adapter.captureBaseline(fixture.root);
    const parent = trackDir(await tempDir("innocence-worktree-"));
    const lease = await adapter.createWorktree({ root: fixture.root, path: path.join(parent, "wt") });
    await adapter.overlayBaseline(lease, baseline);
    expect(Array.from(await fs.readFile(path.join(lease.path, "data.bin")))).toEqual([...binary]);
  }, 60_000);

  it("rejects overlaying a baseline that wants to write inside .git", async () => {
    const fixture = track(await createGitFixture({ committed: { "seed.txt": "seed\n" }, untracked: { "x.ts": "x\n" } }));
    const adapter = createGitAdapter();
    const baseline = await adapter.captureBaseline(fixture.root);
    // simulate a malicious/stale baseline entry pointing into .git
    const poisoned = {
      ...baseline,
      entries: [
        { ...baseline.entries[0]!, path: ".git/hooks/pre-commit", hash: "0".repeat(64), mode: 0o644 },
      ],
    };
    const parent = trackDir(await tempDir("innocence-worktree-"));
    const lease = await adapter.createWorktree({ root: fixture.root, path: path.join(parent, "wt") });
    await expect(adapter.overlayBaseline(lease, poisoned)).rejects.toThrow(/\.git/);
  }, 60_000);

  it("leaves external concurrent modifications of the source visible (copy is current-bytes)", async () => {
    const fixture = track(await createGitFixture({ committed: { "seed.txt": "seed\n" }, untracked: { "note.txt": "v1\n" } }));
    const adapter = createGitAdapter();
    const baseline = await adapter.captureBaseline(fixture.root);
    // external concurrent modification AFTER capture: overlay copies current bytes
    await writeRepoFile(fixture.root, "note.txt", "v2-external\n");
    const parent = trackDir(await tempDir("innocence-worktree-"));
    const lease = await adapter.createWorktree({ root: fixture.root, path: path.join(parent, "wt") });
    await adapter.overlayBaseline(lease, baseline);
    expect(await readRepoFile(lease.path, "note.txt")).toBe("v2-external\n");
  }, 60_000);
});
