import { describe, expect, it } from "vitest";
import {
  addFile,
  createCheckpoint,
  createTaskHead,
  withActiveRouteId,
  withLastCommittedEventId,
  withTaskStatus,
  type FileSnapshotRef,
} from "../src/index";

const file = (path: string, hash = `h-${path}`): FileSnapshotRef => ({
  path,
  exists: true,
  hash,
  mode: 0o644,
  binary: false,
});

describe("checkpoint immutability", () => {
  it("does not mutate an existing checkpoint", () => {
    const checkpoint = createCheckpoint({ checkpointId: "c1", files: [] });
    const next = addFile(checkpoint, { path: "src/a.ts", exists: true, hash: "h1", mode: 0o644, binary: false });
    expect(checkpoint.files).toEqual([]);
    expect(next.files).toHaveLength(1);
  });

  it("defaults identity fields and files", () => {
    const checkpoint = createCheckpoint({ checkpointId: "c1" });
    expect(checkpoint).toEqual({
      checkpointId: "c1",
      taskId: "",
      routeId: "",
      turnId: "",
      files: [],
    });
  });

  it("copies the input file list instead of aliasing it", () => {
    const files: FileSnapshotRef[] = [];
    const checkpoint = createCheckpoint({ checkpointId: "c1", files });
    files.push(file("src/a.ts"));
    expect(checkpoint.files).toHaveLength(0);
  });

  it("deep-copies the file objects it stores", () => {
    const snapshot = file("src/a.ts", "h1");
    const checkpoint = createCheckpoint({ checkpointId: "c1", files: [snapshot] });
    snapshot.hash = "mutated";
    expect(checkpoint.files[0]?.hash).toBe("h1");
  });

  it("replaces the snapshot for an already-recorded path", () => {
    const checkpoint = createCheckpoint({ checkpointId: "c1", files: [file("src/a.ts", "h1")] });
    const next = addFile(checkpoint, file("src/a.ts", "h2"));
    expect(next.files).toHaveLength(1);
    expect(next.files[0]?.hash).toBe("h2");
    expect(checkpoint.files[0]?.hash).toBe("h1");
  });

  it("does not alias the file objects it stores", () => {
    const snapshot = file("src/a.ts", "h1");
    const next = addFile(createCheckpoint({ checkpointId: "c1" }), snapshot);
    snapshot.hash = "mutated";
    expect(next.files[0]?.hash).toBe("h1");
  });
});

describe("task head helpers", () => {
  const head = createTaskHead({
    taskId: "t1",
    sessionId: "s1",
    workspaceRoot: "D:/repo",
    workspaceKind: "git",
    mode: "isolated",
    activeRouteId: "r0",
  });

  it("creates a ready head with schema version 1 and no committed event", () => {
    expect(head).toEqual({
      schemaVersion: 1,
      taskId: "t1",
      sessionId: "s1",
      workspaceRoot: "D:/repo",
      workspaceKind: "git",
      mode: "isolated",
      activeRouteId: "r0",
      status: "ready",
      lastCommittedEventId: null,
    });
  });

  it("returns new heads instead of mutating", () => {
    const running = withTaskStatus(head, "running");
    expect(running).not.toBe(head);
    expect(head.status).toBe("ready");
    expect(running.status).toBe("running");

    const committed = withLastCommittedEventId(running, "e9");
    expect(committed.lastCommittedEventId).toBe("e9");
    expect(running.lastCommittedEventId).toBeNull();

    const rerouted = withActiveRouteId(committed, "r1");
    expect(rerouted.activeRouteId).toBe("r1");
    expect(committed.activeRouteId).toBe("r0");
  });
});
