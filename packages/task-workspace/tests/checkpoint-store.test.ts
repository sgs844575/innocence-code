import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCheckpoint, addFile } from "@innocencecode/task-core";
import { openSecureStorage } from "@innocencecode/secure-storage-node";
import { createCheckpointStore } from "../src/checkpoint-store.ts";

let base: string;

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-tws-cpstore-"));
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

async function createStore() {
  const storage = await openSecureStorage(path.join(base, `store-${Math.random().toString(36).slice(2)}`), {
    dirs: ["checkpoints"],
  });
  return { storage, store: createCheckpointStore(storage) };
}

describe("checkpoint store", () => {
  it("round-trips a checkpoint through checkpoints/<id>.json", async () => {
    const { storage, store } = await createStore();
    const checkpoint = addFile(
      createCheckpoint({ checkpointId: "cp_1", taskId: "task_1", routeId: "route_1", turnId: "turn_1" }),
      { path: "a.txt", exists: true, hash: "a".repeat(64), mode: 0o644, binary: false },
    );
    const writtenPath = await store.write(checkpoint);
    expect(writtenPath).toBe(path.join(storage.root, "checkpoints", "cp_1.json"));
    expect(await store.read("cp_1")).toEqual(checkpoint);
  });

  it("returns null for unknown checkpoints and lists known ids", async () => {
    const { store } = await createStore();
    expect(await store.read("missing")).toBeNull();
    await store.write(createCheckpoint({ checkpointId: "cp_b" }));
    await store.write(createCheckpoint({ checkpointId: "cp_a" }));
    expect(await store.list()).toEqual(["cp_a", "cp_b"]);
  });

  it("atomically overwrites a checkpoint with newer content", async () => {
    const { store } = await createStore();
    await store.write(createCheckpoint({ checkpointId: "cp_1", turnId: "turn-1" }));
    await store.write(createCheckpoint({ checkpointId: "cp_1", turnId: "turn-2" }));
    expect((await store.read("cp_1"))!.turnId).toBe("turn-2");
  });

  it("rejects unsafe checkpoint ids on write, read and path resolution", async () => {
    const { store } = await createStore();
    for (const bad of ["../escape", "a/b", "", "..", "bad id", ".hidden"]) {
      await expect(store.write(createCheckpoint({ checkpointId: bad }))).rejects.toThrow();
      await expect(store.read(bad)).rejects.toThrow();
    }
    await expect(store.write(createCheckpoint({ checkpointId: "ok_1" }))).resolves.toBeTruthy();
  });
});
