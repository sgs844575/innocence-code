// Task runtime IPC composition tests (Task 12) — electron-free: the wiring
// module's Electron touchpoints are dynamic imports inside register*(), so
// only the pure pieces run here: the core-event → push-DTO mapping and the
// startup restart-recovery pass over REAL task-workspace storage (truncated
// tail, mid-file corruption, worktree retry command, restart warnings).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  reduceTask,
  taskCreatedEvent,
  turnPreparedEvent,
  type TaskEvent,
} from "@innocencecode/task-core";
import { openTaskRepository } from "@innocencecode/task-workspace";
import type { TaskRuntimeBridge } from "./taskRuntimeBridge";
import { recoverPersistedTaskRuntimes, toTaskUiEvent, type TaskRuntimeIpcDeps } from "./taskRuntimeIpc";
import type { TaskUiNotice } from "../shared/taskIpc";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return dir;
}

function createdTask(overrides?: Partial<{ taskId: string; sessionId: string; routeId: string }>): TaskEvent {
  return taskCreatedEvent({
    taskId: overrides?.taskId ?? "t1",
    sessionId: overrides?.sessionId ?? "s1",
    routeId: overrides?.routeId ?? "main",
    workspaceRoot: "/workspace",
    workspaceKind: "git",
    mode: "baseline",
    baselineCheckpointId: "ckpt_base",
  });
}

function fakeBridge(overrides?: {
  recoverTask?: (taskId: string) => Promise<ReturnType<typeof reduceTask>>;
}): TaskRuntimeBridge {
  return {
    get: () => undefined,
    listTasks: () => [],
    listEvents: async () => [] as TaskEvent[],
    onTaskEvent: () => () => {},
    recoverTask: overrides?.recoverTask ?? (async () => reduceTask([])),
    releaseTask: async () => {},
    deleteTask: async () => {},
    disposeAll: async () => {},
  } as unknown as TaskRuntimeBridge;
}

interface Harness {
  deps: TaskRuntimeIpcDeps;
  notices: TaskUiNotice[];
}

async function makeHarness(bridge: TaskRuntimeBridge, storageDir: string): Promise<Harness> {
  const notices: TaskUiNotice[] = [];
  const deps: TaskRuntimeIpcDeps = {
    bridge,
    taskStorageDir: storageDir,
    resolveRouteRoot: () => undefined,
    getEditorCommand: () => "",
    send: (channel, payload) => {
      if (channel === "task:notice") notices.push(payload as TaskUiNotice);
    },
  };
  return { deps, notices };
}

describe("toTaskUiEvent", () => {
  it("maps taskCreated with its own session/route and version", () => {
    const bridge = fakeBridge();
    const event = toTaskUiEvent(bridge, { taskId: "t1", event: createdTask() });
    expect(event).toMatchObject({ taskId: "t1", sessionId: "s1", routeId: "main", kind: "taskCreated" });
    expect(typeof event.version).toBe("string");
  });

  it("task-level events fall back to the live handle's route", () => {
    const bridge = { ...fakeBridge(), get: () => ({ sessionId: "s1", routeId: "r_active" }) } as unknown as TaskRuntimeBridge;
    const event = toTaskUiEvent(bridge, {
      taskId: "t1",
      event: { type: "taskStatus", status: "review", eventId: "evt_9", at: "now" },
    });
    expect(event.routeId).toBe("r_active");
    expect(event.status).toBe("review");
    expect(event.version).toBe("evt_9");
  });
});

describe("recoverPersistedTaskRuntimes", () => {
  it("reports a truncated tail as an inconsistency recovered from the last complete event", async () => {
    const storageDir = await tempDir("ic-rtipc-");
    const repository = await openTaskRepository(storageDir, "t1");
    await repository.append([createdTask()]);
    // Torn final append (no newline): the crash-mid-write shape.
    await repository.storage.storage.appendFile("events.jsonl", '{"type":"taskSta');

    const { deps, notices } = await makeHarness(fakeBridge(), storageDir);
    await recoverPersistedTaskRuntimes(deps);

    const notice = notices.find((n) => n.type === "inconsistencyRecovered");
    expect(notice).toBeDefined();
    expect(notice !== undefined && notice.type === "inconsistencyRecovered" && notice.recoveredFromEventId).toBeTruthy();
  });

  it("reports mid-file corruption as eventRecoveryFailed, attributed via the persisted head", async () => {
    const storageDir = await tempDir("ic-rtipc-");
    const repository = await openTaskRepository(storageDir, "t1");
    // Corrupt NON-final line: valid, corrupt, valid (a final bad line would
    // be a tolerated torn tail instead — see the truncated-tail test).
    await repository.storage.storage.writeFileAtomic(
      "events.jsonl",
      `${JSON.stringify(createdTask())}\nnot-json\n${JSON.stringify(
        turnPreparedEvent({ turnId: "turn_1", checkpointId: "ckpt_1", routeId: "main" }),
      )}\n`,
    );
    // The unreadable log cannot yield a session — the persisted head can, and
    // the notice must carry it so the owning session's renderer consumes it.
    await repository.writeTaskHead({
      schemaVersion: 1,
      taskId: "t1",
      sessionId: "s1",
      workspaceRoot: "/workspace",
      workspaceKind: "git",
      mode: "baseline",
      activeRouteId: "main",
      status: "ready",
      lastCommittedEventId: null,
    });

    const { deps, notices } = await makeHarness(fakeBridge(), storageDir);
    await recoverPersistedTaskRuntimes(deps);

    const notice = notices.find((n) => n.type === "eventRecoveryFailed");
    expect(notice).toBeDefined();
    expect(notice !== undefined && notice.type === "eventRecoveryFailed" && notice.sessionId).toBe("s1");
    expect(notices.some((n) => n.type === "worktreeFailed")).toBe(false);
  });

  it("surfaces restart warnings for recovered git tasks with prepared turns", async () => {
    const storageDir = await tempDir("ic-rtipc-");
    const repository = await openTaskRepository(storageDir, "t1");
    const events = [
      createdTask(),
      turnPreparedEvent({ turnId: "turn_1", checkpointId: "ckpt_1", routeId: "main" }),
    ];
    await repository.append(events);

    const bridge = fakeBridge({ recoverTask: async () => reduceTask(events) });
    const { deps, notices } = await makeHarness(bridge, storageDir);
    await recoverPersistedTaskRuntimes(deps);

    const notice = notices.find((n) => n.type === "restartRecovered");
    expect(notice).toBeDefined();
    expect(notice !== undefined && notice.type === "restartRecovered" && notice.warnings.some((w) => w.includes("turn_1"))).toBe(true);
  });

  it("retains a worktree failure with its retry command when recovery fails", async () => {
    const storageDir = await tempDir("ic-rtipc-");
    const repository = await openTaskRepository(storageDir, "t1");
    await repository.append([createdTask()]);

    const bridge = fakeBridge({
      recoverTask: async () => {
        throw new Error("worktree recovery exploded");
      },
    });
    const { deps, notices } = await makeHarness(bridge, storageDir);
    await recoverPersistedTaskRuntimes(deps);

    const notice = notices.find((n) => n.type === "worktreeFailed");
    expect(notice).toBeDefined();
    if (notice?.type === "worktreeFailed") {
      expect(notice.retry).toMatchObject({ taskId: "t1", sessionId: "s1", mode: "isolated" });
      expect(notice.message).toContain("worktree recovery exploded");
    }
  });
});
