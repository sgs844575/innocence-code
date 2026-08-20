import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fingerprintHunk } from "@innocencecode/task-core";
import { createPatchEngine } from "../src/diff.ts";
import { scanWorkspace } from "../src/scanner.ts";

let base: string;

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-tws-diff-"));
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

async function snapshotFixture(files: Record<string, Uint8Array | string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(base, "fixture-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, ...name.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

async function snapshotOf(root: string) {
  return scanWorkspace(root);
}

describe("patch engine diff", () => {
  it("detects binary files without creating line hunks", async () => {
    const beforeRoot = await snapshotFixture({ "image.bin": new Uint8Array([0, 255]) });
    const afterRoot = await snapshotFixture({ "image.bin": new Uint8Array([1, 255]) });
    const before = await snapshotOf(beforeRoot);
    const after = await snapshotOf(afterRoot);
    const patch = await createPatchEngine().diff(before, after);
    expect(patch[0]?.binary).toBe(true);
    expect(patch[0]?.hunks).toEqual([]);
  });

  it("produces text hunks whose refs come from task-core fingerprintHunk", async () => {
    const beforeRoot = await snapshotFixture({ "notes.txt": "alpha\nbeta\ngamma\n" });
    const afterRoot = await snapshotFixture({ "notes.txt": "alpha\nBETA!\ngamma\n" });
    const before = await snapshotOf(beforeRoot);
    const after = await snapshotOf(afterRoot);
    const patch = await createPatchEngine().diff(before, after);
    expect(patch).toHaveLength(1);
    expect(patch[0]?.binary).toBe(false);
    expect(patch[0]?.hunks.length).toBeGreaterThan(0);
    const hunk = patch[0]!.hunks[0]!;
    expect(hunk.path).toBe("notes.txt");
    expect(hunk.before).toContain("beta");
    expect(hunk.after).toContain("BETA!");
    expect(hunk.status).toBe("pending");
    expect(hunk.ref).toBe(fingerprintHunk(hunk));
  });

  it("omits unchanged files and reports creation/deletion", async () => {
    const beforeRoot = await snapshotFixture({ "keep.txt": "same\n", "gone.txt": "to be deleted\n" });
    const afterRoot = await snapshotFixture({ "keep.txt": "same\n", "new.txt": "created\n" });
    const before = await snapshotOf(beforeRoot);
    const after = await snapshotOf(afterRoot);
    const patches = await createPatchEngine().diff(before, after);
    const paths = patches.map((patch) => patch.path).sort();
    expect(paths).toEqual(["gone.txt", "new.txt"]);
    const deleted = patches.find((patch) => patch.path === "gone.txt")!;
    expect(deleted.before.exists).toBe(true);
    expect(deleted.after.exists).toBe(false);
    const created = patches.find((patch) => patch.path === "new.txt")!;
    expect(created.before.exists).toBe(false);
    expect(created.after.exists).toBe(true);
    // Before content still readable from the before snapshot's root: a full
    // deletion hunk (before -> empty) is produced.
    expect(deleted.hunks).toHaveLength(1);
    expect(deleted.hunks[0]!.before).toContain("to be deleted");
    expect(deleted.hunks[0]!.after).toBe("");
    expect(created.hunks).toHaveLength(1);
    expect(created.hunks[0]!.before).toBe("");
    expect(created.hunks[0]!.after).toContain("created");
  });

  it("degrades deletions to file-level patches when before content is gone (same-root rescan)", async () => {
    const root = await snapshotFixture({ "victim.txt": "vanishing\n" });
    const before = await snapshotOf(root);
    await fs.rm(path.join(root, "victim.txt"));
    const after = await snapshotOf(root);
    const patch = await createPatchEngine().diff(before, after);
    expect(patch).toHaveLength(1);
    expect(patch[0]!.after.exists).toBe(false);
    expect(patch[0]!.hunks).toEqual([]);
  });

  it("degrades over-cap text files to file-level patches with no hunks", async () => {
    const big = "line\n".repeat(10);
    const bigger = "LINE!\n".repeat(10);
    const beforeRoot = await snapshotFixture({ "big.txt": big });
    const afterRoot = await snapshotFixture({ "big.txt": bigger });
    const before = await snapshotOf(beforeRoot);
    const after = await snapshotOf(afterRoot);
    const engine = createPatchEngine({ maxTextBytes: 8 });
    const patch = await engine.diff(before, after);
    expect(patch).toHaveLength(1);
    expect(patch[0]?.binary).toBe(false);
    expect(patch[0]?.hunks).toEqual([]);
  });

  it("marks snapshots with exists/hash/mode/binary per file", async () => {
    const root = await snapshotFixture({ "a.txt": "text\n", "b.bin": new Uint8Array([0, 1, 2]) });
    const snapshot = await scanWorkspace(root);
    const a = snapshot.files.find((file) => file.path === "a.txt")!;
    const b = snapshot.files.find((file) => file.path === "b.bin")!;
    expect(a.exists).toBe(true);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.mode).not.toBeNull();
    expect(a.binary).toBe(false);
    expect(b.binary).toBe(true);
    expect(snapshot.files.map((file) => file.path)).toEqual(["a.txt", "b.bin"]);
  });

  it("refuses to scan paths that escape the workspace root", async () => {
    const root = await snapshotFixture({ "a.txt": "text\n" });
    const snapshot = await scanWorkspace(root);
    await expect(snapshot).toBeTruthy();
    // Relative-path helpers used by diff/apply must reject traversal.
    const { isSafeRelativePath } = await import("../src/scanner.ts");
    expect(isSafeRelativePath("a/b.txt")).toBe(true);
    expect(isSafeRelativePath("../escape")).toBe(false);
    expect(isSafeRelativePath("a/../../escape")).toBe(false);
    expect(isSafeRelativePath("C:/abs")).toBe(false);
    expect(isSafeRelativePath("/abs")).toBe(false);
  });
});
