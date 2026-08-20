import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceWatcher, type WorkspaceFileEvent, type WorkspaceWatcher } from "../src/watcher.ts";
import { sha256Bytes } from "../src/content-store.ts";

let base: string;
const watchers: WorkspaceWatcher[] = [];

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-tws-watcher-"));
});

afterEach(async () => {
  // vitest hangs on open file handles: always close watchers
  while (watchers.length > 0) {
    await watchers.pop()!.stop();
  }
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const hashOf = (text: string) => sha256Bytes(new TextEncoder().encode(text));

function record(events: WorkspaceFileEvent[]) {
  return (event: WorkspaceFileEvent) => {
    events.push(event);
  };
}

async function waitFor(events: WorkspaceFileEvent[], count: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (events.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} events; got ${events.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("workspace watcher", () => {
  it("reports modifications with relative paths and before/after hashes", async () => {
    const root = await fs.mkdtemp(path.join(base, "ws-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "app.ts"), "v1\n");

    const events: WorkspaceFileEvent[] = [];
    const watcher = createWorkspaceWatcher(root, { onEvent: record(events) });
    watchers.push(watcher);
    await watcher.start();

    await fs.writeFile(path.join(root, "src", "app.ts"), "v2\n");
    await waitFor(events, 1);

    expect(events[0]!.path).toBe("src/app.ts");
    expect(events[0]!.beforeHash).toBe(hashOf("v1\n"));
    expect(events[0]!.afterHash).toBe(hashOf("v2\n"));
    expect(typeof events[0]!.timestamp).toBe("number");
    expect(events[0]!.timestamp).toBeLessThanOrEqual(Date.now());

    // a second modification carries the previous after-hash as its before-hash
    await fs.writeFile(path.join(root, "src", "app.ts"), "v3\n");
    await waitFor(events, 2);
    expect(events[1]!.beforeHash).toBe(hashOf("v2\n"));
    expect(events[1]!.afterHash).toBe(hashOf("v3\n"));
  }, 15000);

  it("reports creations (beforeHash null) and deletions (afterHash null)", async () => {
    const root = await fs.mkdtemp(path.join(base, "ws-"));
    await fs.writeFile(path.join(root, "keep.txt"), "keep\n");

    const events: WorkspaceFileEvent[] = [];
    const watcher = createWorkspaceWatcher(root, { onEvent: record(events) });
    watchers.push(watcher);
    await watcher.start();

    await fs.writeFile(path.join(root, "born.txt"), "born\n");
    await waitFor(events, 1);
    expect(events[0]!.path).toBe("born.txt");
    expect(events[0]!.beforeHash).toBeNull();
    expect(events[0]!.afterHash).toBe(hashOf("born\n"));

    await fs.rm(path.join(root, "born.txt"));
    await waitFor(events, 2);
    expect(events[1]!.path).toBe("born.txt");
    expect(events[1]!.beforeHash).toBe(hashOf("born\n"));
    expect(events[1]!.afterHash).toBeNull();
  }, 15000);

  it("emits source unknown and nothing else — attribution is the caller's job", async () => {
    const root = await fs.mkdtemp(path.join(base, "ws-"));
    const events: WorkspaceFileEvent[] = [];
    const watcher = createWorkspaceWatcher(root, { onEvent: record(events) });
    watchers.push(watcher);
    await watcher.start();

    await fs.writeFile(path.join(root, "file.txt"), "x\n");
    await waitFor(events, 1);
    expect(Object.keys(events[0]).sort()).toEqual(["afterHash", "beforeHash", "path", "source", "timestamp"]);
    expect(events[0]!.source).toBe("unknown");
  }, 15000);

  it("honors the ignore predicate", async () => {
    const root = await fs.mkdtemp(path.join(base, "ws-"));
    await fs.mkdir(path.join(root, ".git"), { recursive: true });

    const events: WorkspaceFileEvent[] = [];
    const watcher = createWorkspaceWatcher(root, {
      onEvent: record(events),
      ignore: (relativePath) => relativePath === ".git/config" || relativePath.startsWith(".git/"),
    });
    watchers.push(watcher);
    await watcher.start();

    await fs.writeFile(path.join(root, ".git", "config"), "[core]\n");
    await fs.writeFile(path.join(root, "normal.txt"), "tracked\n");
    await waitFor(events, 1);

    expect(events.map((event) => event.path)).toEqual(["normal.txt"]);
    // give the ignored write a moment to (not) arrive
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(events).toHaveLength(1);
  }, 15000);

  it("stops emitting after stop()", async () => {
    const root = await fs.mkdtemp(path.join(base, "ws-"));
    const events: WorkspaceFileEvent[] = [];
    const watcher = createWorkspaceWatcher(root, { onEvent: record(events) });
    await watcher.start();
    await fs.writeFile(path.join(root, "before-stop.txt"), "1\n");
    await waitFor(events, 1);
    await watcher.stop();
    await watcher.stop(); // idempotent

    await fs.writeFile(path.join(root, "after-stop.txt"), "2\n");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(events).toHaveLength(1);
  }, 15000);
});
