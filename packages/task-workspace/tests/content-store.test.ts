import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSecureStorage } from "@innocencecode/secure-storage-node";
import { createContentStore } from "../src/content-store.ts";

let base: string;

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-tws-content-"));
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

async function createTempContentStore() {
  const storage = await openSecureStorage(path.join(base, `store-${Math.random().toString(36).slice(2)}`));
  return createContentStore(storage);
}

describe("content store (CAS)", () => {
  it("deduplicates content by sha256 and writes atomically", async () => {
    const store = await createTempContentStore();
    const first = await store.put(new TextEncoder().encode("same"));
    const second = await store.put(new TextEncoder().encode("same"));
    expect(second.key).toBe(first.key);
    expect(await store.has(first)).toBe(true);
  });

  it("keys are raw sha256 hex of the content", async () => {
    const store = await createTempContentStore();
    const { createHash } = await import("node:crypto");
    const content = new TextEncoder().encode("innocence");
    const { key } = await store.put(content);
    expect(key).toBe(createHash("sha256").update(content).digest("hex"));
  });

  it("stores different contents under different keys and reads them back byte-exact", async () => {
    const store = await createTempContentStore();
    const a = await store.put(new Uint8Array([1, 2, 3]));
    const b = await store.put(new Uint8Array([3, 2, 1]));
    expect(a.key).not.toBe(b.key);
    expect(Array.from(await store.get(a.key))).toEqual([1, 2, 3]);
    expect(Array.from(await store.get(b.key))).toEqual([3, 2, 1]);
  });

  it("reports unknown objects as absent and refuses unsafe keys", async () => {
    const store = await createTempContentStore();
    expect(await store.has("0".repeat(64))).toBe(false);
    await expect(store.get("0".repeat(64))).rejects.toThrow();
    await expect(store.has("../escape")).rejects.toThrow();
    await expect(store.get("zz")).rejects.toThrow();
    await expect(store.put(new Uint8Array([9]))).resolves.toHaveProperty("key");
  });

  it("writes each object exactly once under objects/ (dedup does not rewrite)", async () => {
    const storage = await openSecureStorage(path.join(base, `dedup-${Math.random().toString(36).slice(2)}`));
    const store = createContentStore(storage);
    const content = new TextEncoder().encode("stable-bytes");
    const { key } = await store.put(content);
    const objectPath = path.join(storage.root, "objects", key);
    const first = await fs.stat(objectPath);
    expect(first.isFile()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.put(content);
    const second = await fs.stat(objectPath);
    // Same inode/mtime: the second put must not have replaced the file.
    expect(second.mtimeMs).toBe(first.mtimeMs);
    expect(second.ino).toBe(first.ino);
  });
});
