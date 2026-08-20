import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSecureStorage } from "@innocencecode/secure-storage-node";
import { createContentStore, sha256Bytes } from "../src/content-store.ts";
import { scanWorkspace } from "../src/scanner.ts";
import { createPatchEngine } from "../src/diff.ts";

let base: string;

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-tws-apply-"));
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

async function createWorkspace(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(base, "ws-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, ...name.split("/")), content);
  }
  return root;
}

/** Scans the workspace and puts every file's content into the CAS so reverse
 * apply can find the desired (before) bytes. */
async function snapshotAndStore(root: string) {
  const storage = await openSecureStorage(path.join(base, `store-${Math.random().toString(36).slice(2)}`));
  const objects = createContentStore(storage);
  const snapshot = await scanWorkspace(root);
  for (const file of snapshot.files) {
    await objects.put(new Uint8Array(await fs.readFile(path.join(root, ...file.path.split("/")))));
  }
  return { storage, objects, snapshot, engine: createPatchEngine({ storage, contentStore: objects }) };
}

describe("reverse apply", () => {
  it("restores modified, deleted and created files to their before bytes", async () => {
    const root = await createWorkspace({ "a.txt": "A1\n", "b.txt": "B1\n", "c.txt": "C1\n" });
    const { objects, snapshot: before, engine } = await snapshotAndStore(root);

    await fs.writeFile(path.join(root, "a.txt"), "A2\n");
    await fs.rm(path.join(root, "b.txt"));
    await fs.writeFile(path.join(root, "d.txt"), "D-new\n");
    const after = await scanWorkspace(root);
    const patches = await engine.diff(before, after);
    expect(patches.map((patch) => patch.path).sort()).toEqual(["a.txt", "b.txt", "d.txt"]);

    const result = await engine.applyReverse({ root, patches });
    expect(result.conflicts).toEqual([]);
    expect([...result.applied].sort()).toEqual(["a.txt", "b.txt", "d.txt"]);

    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("A1\n");
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("B1\n");
    expect(await fs.readFile(path.join(root, "c.txt"), "utf8")).toBe("C1\n");
    await expect(fs.readFile(path.join(root, "d.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    // backups of the pre-transaction content were stored for recovery
    expect(await objects.has(sha256Bytes(new TextEncoder().encode("A2\n")))).toBe(true);
  });

  it("reports expected-hash conflicts and overwrites nothing", async () => {
    const root = await createWorkspace({ "a.txt": "A1\n" });
    const { storage, snapshot: before, engine } = await snapshotAndStore(root);

    await fs.writeFile(path.join(root, "a.txt"), "A2\n");
    const after = await scanWorkspace(root);
    const patches = await engine.diff(before, after);
    // the workspace changes again AFTER the diff: expected hash no longer matches
    await fs.writeFile(path.join(root, "a.txt"), "TAMPER\n");

    const result = await engine.applyReverse({ root, patches });
    expect(result.applied).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.path).toBe("a.txt");
    expect(result.conflicts[0]!.expected).toBe(sha256Bytes(new TextEncoder().encode("A2\n")));
    expect(result.conflicts[0]!.actual).toBe(sha256Bytes(new TextEncoder().encode("TAMPER\n")));
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("TAMPER\n");
    // aborted before journaling: no transaction files on disk
    expect(await storage.listDir("apply-journal")).toEqual([]);
  });

  it("restores binary files byte-exact", async () => {
    const beforeBytes = new Uint8Array([0, 159, 146, 150, 0, 1]);
    const afterBytes = new Uint8Array([0, 159, 146, 150, 0, 2]);
    const root = await createWorkspace({});
    await fs.writeFile(path.join(root, "blob.bin"), beforeBytes);
    const { snapshot: before, engine } = await snapshotAndStore(root);
    await fs.writeFile(path.join(root, "blob.bin"), afterBytes);
    const after = await scanWorkspace(root);
    const patches = await engine.diff(before, after);
    expect(patches[0]!.binary).toBe(true);
    const result = await engine.applyReverse({ root, patches });
    expect(result.conflicts).toEqual([]);
    expect(Array.from(await fs.readFile(path.join(root, "blob.bin")))).toEqual([...beforeBytes]);
  });
});

describe("three-way preflight", () => {
  it("is clean while the disk matches base or already matches target", async () => {
    const root = await createWorkspace({ "a.txt": "1\n" });
    const { snapshot: base, engine } = await snapshotAndStore(root);
    const target = [{ path: "a.txt", exists: true, hash: sha256Bytes(new TextEncoder().encode("2\n")), mode: 0o644, binary: false }];
    const report = await engine.preflightThreeWay({ root, base: base.files, target });
    expect(report.clean).toBe(true);
    expect(report.conflicts).toEqual([]);

    await fs.writeFile(path.join(root, "a.txt"), "2\n");
    const afterTarget = await engine.preflightThreeWay({ root, base: base.files, target });
    expect(afterTarget.clean).toBe(true);
  });

  it("conflicts when the disk matches neither base nor target", async () => {
    const root = await createWorkspace({ "a.txt": "1\n" });
    const { snapshot: base, engine } = await snapshotAndStore(root);
    await fs.writeFile(path.join(root, "a.txt"), "diverged\n");
    const target = [{ path: "a.txt", exists: true, hash: sha256Bytes(new TextEncoder().encode("2\n")), mode: 0o644, binary: false }];
    const report = await engine.preflightThreeWay({ root, base: base.files, target });
    expect(report.clean).toBe(false);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]!.path).toBe("a.txt");
    expect(report.conflicts[0]!.expected).toBe(base.files[0]!.hash);
    expect(report.conflicts[0]!.actual).toBe(sha256Bytes(new TextEncoder().encode("diverged\n")));
  });
});
