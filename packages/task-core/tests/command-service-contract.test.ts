// TaskCommandService contract tests (Task 13): the ONE host-agnostic command
// service. Two halves:
//   1. Surface contract — the plan-fixed method set is present on every
//      service instance, mutations acquire the task lease BEFORE the
//      workspace lease, and every mutation runs under one context.
//   2. Error semantics — unknown task / route, version conflict, hunk scope,
//      completion gate (unreviewed hunks, unresolved conflicts, unstable
//      turns, validation + override), conflict resolution through the new
//      conflictResolved event, switchRoute persistence through the new
//      activeRouteChanged event, and recovery warnings. Everything runs over
//      FAKE ports (no filesystem, no Git) and the REAL reducer.
import { describe, expect, it } from "vitest";
import {
  createTaskCommandService,
  TASK_COMMAND_METHODS,
  TaskCommandError,
  type TaskCommandDeps,
} from "../src/command-service";
import type { TaskCommandStore, TaskMutationLease } from "../src/command-ports";
import {
  reduceTask,
  taskCreatedEvent,
  turnCheckpointedEvent,
  turnPreparedEvent,
  type Checkpoint,
  type FileSnapshotRef,
  type TaskEvent,
  type TaskHead,
} from "../src/index";

// ---------------------------------------------------------------------------
// In-memory port fakes (the service's only collaborators)
// ---------------------------------------------------------------------------

interface TaskRecord {
  events: TaskEvent[];
  checkpoints: Map<string, Checkpoint>;
  objects: Map<string, Uint8Array>;
  artifacts: Map<string, string>;
  head: TaskHead | null;
}

function recordOf(seed: TaskEvent[] = [], checkpointFiles: FileSnapshotRef[] = []): TaskRecord {
  const created = seed[0] ?? taskCreatedEvent({
    taskId: "t1",
    sessionId: "s1",
    routeId: "main",
    workspaceRoot: "ws://t1",
    baselineCheckpointId: "ckpt_base",
  });
  const rec: TaskRecord = {
    events: [...seed, ...(seed.length === 0 ? [created] : [])],
    checkpoints: new Map([["ckpt_base", {
      checkpointId: "ckpt_base",
      taskId: "t1",
      routeId: "main",
      turnId: "",
      files: checkpointFiles,
    }]]),
    objects: new Map(),
    artifacts: new Map(),
    head: null,
  };
  return rec;
}

function fakeDeps(init?: { seed?: TaskEvent[]; checkpointFiles?: FileSnapshotRef[] }) {
  const tasks = new Map<string, TaskRecord>([["t1", recordOf(init?.seed, init?.checkpointFiles)]]);
  const order: string[] = [];

  const store: TaskCommandStore = {
    listEvents: async (taskId) => [...(tasks.get(taskId)?.events ?? [])],
    appendEvents: async (taskId, events) => {
      const rec = tasks.get(taskId);
      if (!rec) throw new Error(`no such task: ${taskId}`);
      rec.events.push(...events.map((event) => ({ ...event })));
    },
    readTaskHead: async (taskId) => tasks.get(taskId)?.head ?? null,
    writeTaskHead: async (taskId, head) => {
      const rec = tasks.get(taskId);
      if (rec) rec.head = { ...head };
    },
    readCheckpoint: async (taskId, checkpointId) =>
      (tasks.get(taskId)?.checkpoints.get(checkpointId) as Checkpoint | undefined) ?? null,
    writeCheckpoint: async (taskId, checkpoint) => {
      tasks.get(taskId)?.checkpoints.set(checkpoint.checkpointId, { ...checkpoint });
    },
    putObject: async (taskId, data) => {
      const hash = `hash-${data.length}-${[...data].reduce((a, b) => a + b, 0)}`;
      tasks.get(taskId)?.objects.set(hash, data);
      return hash;
    },
    getObject: async (taskId, hash) => {
      const object = tasks.get(taskId)?.objects.get(hash);
      if (!object) throw new Error(`object not found: ${hash}`);
      return object;
    },
    writeArtifact: async (taskId, name, data) => {
      tasks.get(taskId)?.artifacts.set(name, data);
    },
    readArtifact: async (taskId, name) => tasks.get(taskId)?.artifacts.get(name) ?? null,
  };

  const deps: TaskCommandDeps = {
    store,
    locks: {
      async acquireTaskLease(taskId) {
        order.push(`task:${taskId}`);
        return { [Symbol.asyncDispose]: async () => { order.push("release-task"); } };
      },
      async acquireWorkspaceLease(key) {
        order.push(`workspace:${key}`);
        return { [Symbol.asyncDispose]: async () => { order.push("release-workspace"); } };
      },
    },
    workspace: {
      canonicalKey: async (root) => root,
      scan: async (root) => ({ root, files: init?.checkpointFiles ?? [] }),
      hash: async () => null,
      read: async () => null,
    },
    git: {
      detect: async (root) => ({ isRepo: true, root, branch: null }),
      captureBaseline: async () => ({ root: "ws://t1", headCommit: "commit-1" }),
      createWorktree: async (input) => ({ path: input.path, lease: { path: input.path } }),
      overlayBaseline: async () => {},
      recoverWorktree: async (input) => ({ path: input.path, lease: { path: input.path } }),
      destroyWorktree: async () => {},
      closeLease: async () => {},
      preflightApply: async () => ({ conflicts: [], clean: true }),
      applyAccepted: async () => ({ applied: [], conflicts: [] }),
    },
    diff: {
      // baseline == current workspace: no changed files by default; tests may override
      diff: async (input) => {
        void input;
        return [];
      },
    },
    attribution: {
      decisions: (events) => {
        const statuses = new Map<string, { path: string; status: string }>();
        const resolved = new Set<string>();
        for (const event of events) {
          if (event.type === "attributionPending" || event.type === "attributionConflict") {
            for (const path of event.paths) {
              statuses.set(path, { path, status: event.type === "attributionPending" ? "attribution-pending" : "conflict" });
            }
          } else if (event.type === "attributionResolved" || event.type === "conflictResolved") {
            resolved.add(event.path);
            statuses.set(event.path, { path: event.path, status: event.attribution === "task-owned" ? "pending-review" : "excluded" });
          }
        }
        void resolved;
        return [...statuses.values()].map((decision) => ({ status: decision.status as "conflict", path: decision.path }));
      },
    },
    fork: {
      createForkedRoute: async (input) => ({
        route: {
          routeId: "route_fork",
          parentRouteId: input.resolved.parentRouteId,
          forkTurnId: input.resolved.sourceTurnId,
          checkpointId: input.resolved.checkpointId,
          workspaceRoot: "ws://t1/fork",
          readonly: false,
        },
        prompt: input.resolved.prompt,
      }),
    },
    recover: { recoverTask: async () => reduceTask(await store.listEvents("t1")) },
    delete: { deleteTask: async () => {} },
    validator: async () => ({ success: true }),
  };
  return { deps, order, tasks };
}

const fileRef = (path: string, hash: string | null): FileSnapshotRef => ({
  path, exists: hash !== null, hash, mode: hash !== null ? 0o100644 : null, binary: false,
});

describe("TaskCommandService surface contract", () => {
  it("exposes the plan-fixed method set", () => {
    const service = createTaskCommandService(fakeDeps().deps);
    for (const method of TASK_COMMAND_METHODS) {
      expect(typeof (service as unknown as Record<string, unknown>)[method], method).toBe("function");
    }
  });

  it("acquires the task lease BEFORE the workspace lease and releases both in reverse", async () => {
    const { deps, order } = fakeDeps({ checkpointFiles: [fileRef("a.txt", "h1")] });
    deps.diff.diff = async () => [{
      path: "a.txt",
      before: fileRef("a.txt", "h1"),
      after: fileRef("a.txt", "h2"),
      binary: false,
      hunks: [{ ref: "ref-1", path: "a.txt", before: "one\n", after: "two\n", context: [], status: "pending" }],
    }];
    const service = createTaskCommandService(deps);
    await service.review({ taskId: "t1", routeId: "main", hunkRef: "ref-1", status: "accepted", expectedVersion: undefined });
    const taskIndex = order.findIndex((entry) => entry.startsWith("task:"));
    const workspaceIndex = order.findIndex((entry) => entry.startsWith("workspace:"));
    expect(taskIndex).toBeGreaterThanOrEqual(0);
    expect(workspaceIndex).toBeGreaterThan(taskIndex);
    expect(order.slice(-2)).toEqual(["release-workspace", "release-task"]);
  });
});

describe("TaskCommandService error semantics", () => {
  it("rejects unknown tasks with task-not-found", async () => {
    const service = createTaskCommandService(fakeDeps().deps);
    await expect(service.get("nope")).rejects.toMatchObject({ code: "task-not-found" });
    await expect(service.listHunks("nope", "main")).rejects.toMatchObject({ code: "task-not-found" });
  });

  it("rejects unknown routes with route-not-found", async () => {
    const service = createTaskCommandService(fakeDeps().deps);
    await expect(service.listHunks("t1", "ghost")).rejects.toMatchObject({ code: "route-not-found" });
  });

  it("rejects a stale expectedVersion with version-conflict and writes nothing", async () => {
    const { deps, tasks } = fakeDeps({ checkpointFiles: [fileRef("a.txt", "h1")] });
    deps.diff.diff = async () => [{
      path: "a.txt", before: fileRef("a.txt", "h1"), after: fileRef("a.txt", "h2"), binary: false,
      hunks: [{ ref: "ref-1", path: "a.txt", before: "one\n", after: "two\n", context: [], status: "pending" }],
    }];
    const service = createTaskCommandService(deps);
    const eventsBefore = (await deps.store.listEvents("t1")).length;
    await expect(
      service.review({ taskId: "t1", routeId: "main", hunkRef: "ref-1", status: "accepted", expectedVersion: "v0:stale" }),
    ).rejects.toMatchObject({ code: "version-conflict" });
    expect((await deps.store.listEvents("t1")).length).toBe(eventsBefore);
    expect(tasks.get("t1")).toBeDefined();
  });

  it("rejects a hunk outside the task's current list with hunk-not-found", async () => {
    const service = createTaskCommandService(fakeDeps().deps);
    await expect(
      service.review({ taskId: "t1", routeId: "main", hunkRef: "ref-ghost", status: "accepted", expectedVersion: undefined }),
    ).rejects.toMatchObject({ code: "hunk-not-found" });
  });

  it("blocks completion on unreviewed hunks with the completion gate and its details", async () => {
    const { deps } = fakeDeps({ checkpointFiles: [fileRef("a.txt", "h1")] });
    deps.diff.diff = async () => [{
      path: "a.txt", before: fileRef("a.txt", "h1"), after: fileRef("a.txt", "h2"), binary: false,
      hunks: [{ ref: "ref-1", path: "a.txt", before: "one\n", after: "two\n", context: [], status: "pending" }],
    }];
    const service = createTaskCommandService(deps);
    const error = await service.complete({ taskId: "t1", confirmValidationFailure: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaskCommandError);
    expect((error as TaskCommandError).code).toBe("completion-gate");
    expect((error as TaskCommandError).message).toContain("completion gate");
    const gate = (error as TaskCommandError).details as { gate: { unreviewedChanges: number } };
    expect(gate.gate.unreviewedChanges).toBe(1);
  });

  it("lets completion pass once every hunk is reviewed", async () => {
    const { deps } = fakeDeps({ checkpointFiles: [fileRef("a.txt", "h1")] });
    deps.diff.diff = async () => [{
      path: "a.txt", before: fileRef("a.txt", "h1"), after: fileRef("a.txt", "h2"), binary: false,
      hunks: [{ ref: "ref-1", path: "a.txt", before: "one\n", after: "two\n", context: [], status: "pending" }],
    }];
    const service = createTaskCommandService(deps);
    await service.review({ taskId: "t1", routeId: "main", hunkRef: "ref-1", status: "accepted", expectedVersion: undefined });
    await expect(service.complete({ taskId: "t1", confirmValidationFailure: false })).resolves.toBeUndefined();
  });

  it("blocks completion on an unresolved attribution conflict until resolveConflict clears it via conflictResolved", async () => {
    const { deps } = fakeDeps({
      seed: [
        taskCreatedEvent({ taskId: "t1", sessionId: "s1", routeId: "main", workspaceRoot: "ws://t1", baselineCheckpointId: "ckpt_base" }),
        { type: "attributionConflict", paths: ["c.ts"] } as TaskEvent,
      ],
    });
    const service = createTaskCommandService(deps);
    await expect(service.complete({ taskId: "t1", confirmValidationFailure: false }))
      .rejects.toMatchObject({ code: "completion-gate" });

    await service.resolveConflict({ taskId: "t1", routeId: "main", path: "c.ts", attribution: "task-owned" });

    const events = await deps.store.listEvents("t1");
    expect(events.at(-1)).toMatchObject({ type: "conflictResolved", path: "c.ts", attribution: "task-owned" });
    // the whole log still reduces (single-log replayability)
    expect(() => reduceTask(events)).not.toThrow();
    await expect(service.complete({ taskId: "t1", confirmValidationFailure: false })).resolves.toBeUndefined();
  });

  it("attributeUnknown appends attributionResolved for pending paths and fails closed otherwise", async () => {
    const { deps } = fakeDeps({
      seed: [
        taskCreatedEvent({ taskId: "t1", sessionId: "s1", routeId: "main", workspaceRoot: "ws://t1", baselineCheckpointId: "ckpt_base" }),
        { type: "attributionPending", paths: ["a.ts", "b.ts"] } as TaskEvent,
      ],
    });
    const service = createTaskCommandService(deps);
    await service.attributeUnknown("t1", "a.ts", "task-owned");
    await service.attributeUnknown("t1", "b.ts", "external");
    const events = await deps.store.listEvents("t1");
    expect(events.filter((event) => event.type === "attributionResolved")).toEqual([
      expect.objectContaining({ path: "a.ts", attribution: "task-owned", status: "pending-review", protectedHash: null }),
      expect.objectContaining({ path: "b.ts", attribution: "external", status: "excluded" }),
    ]);
    await expect(service.attributeUnknown("t1", "never-tracked.ts", "external"))
      .rejects.toBeInstanceOf(TaskCommandError);
  });

  it("records validationOverride when completion is confirmed past a failing validation", async () => {
    const { deps } = fakeDeps();
    deps.validator = async () => ({ success: false, message: "lint errors" });
    const service = createTaskCommandService(deps);
    await expect(service.complete({ taskId: "t1", confirmValidationFailure: false }))
      .rejects.toMatchObject({ code: "completion-gate" });
    await expect(service.complete({ taskId: "t1", confirmValidationFailure: true })).resolves.toBeUndefined();
    const events = await deps.store.listEvents("t1");
    expect(events.at(-1)).toMatchObject({ type: "validationOverride", validationResult: { success: false } });
    expect(() => reduceTask(events)).not.toThrow();
  });

  it("persists switchRoute through activeRouteChanged and the reducer folds it", async () => {
    const { deps } = fakeDeps({
      seed: [
        taskCreatedEvent({ taskId: "t1", sessionId: "s1", routeId: "main", workspaceRoot: "ws://t1", baselineCheckpointId: "ckpt_base" }),
      ],
    });
    const service = createTaskCommandService(deps);
    // attach a second route first (routeAttached), then switch back and forth
    await deps.store.appendEvents("t1", [{
      type: "routeAttached",
      route: { routeId: "route_b", parentRouteId: "main", forkTurnId: null, checkpointId: "ckpt_base", workspaceRoot: "ws://t1/b", readonly: false },
    } as TaskEvent]);
    const summary = await service.switchRoute("t1", "route_b");
    expect(summary.routeId).toBe("route_b");
    const state = reduceTask(await deps.store.listEvents("t1"));
    expect(state.activeRouteId).toBe("route_b");
    expect((await service.get("t1")).activeRouteId).toBe("route_b");
    await expect(service.switchRoute("t1", "ghost")).rejects.toMatchObject({ code: "route-not-found" });
  });

  it("reports prepared-but-uncommitted turns as recovery warnings", async () => {
    const { deps } = fakeDeps({
      seed: [
        taskCreatedEvent({ taskId: "t1", sessionId: "s1", routeId: "main", workspaceRoot: "ws://t1", baselineCheckpointId: "ckpt_base" }),
        turnCheckpointedEvent({ checkpointId: "c_turn" }),
        turnPreparedEvent({ turnId: "turn_x", checkpointId: "c_turn", routeId: "main" }),
      ],
    });
    const service = createTaskCommandService(deps);
    const warnings = await service.recoveryWarnings("t1");
    expect(warnings.some((warning) => warning.includes("turn_x"))).toBe(true);
  });
});

describe("TaskMutationLease discipline", () => {
  it("review runs the mutation body while both leases are held", async () => {
    const { deps, order } = fakeDeps({ checkpointFiles: [fileRef("a.txt", "h1")] });
    deps.diff.diff = async () => [{
      path: "a.txt", before: fileRef("a.txt", "h1"), after: fileRef("a.txt", "h2"), binary: false,
      hunks: [{ ref: "ref-1", path: "a.txt", before: "one\n", after: "two\n", context: [], status: "pending" }],
    }];
    let duringMutation: string[] | null = null;
    const original = deps.store.appendEvents.bind(deps.store);
    deps.store.appendEvents = async (taskId, events) => {
      duringMutation = [...order];
      await original(taskId, events);
    };
    const service = createTaskCommandService(deps);
    await service.review({ taskId: "t1", routeId: "main", hunkRef: "ref-1", status: "accepted", expectedVersion: undefined });
    expect(duringMutation).not.toBeNull();
    expect(duringMutation!.some((entry) => entry.startsWith("task:"))).toBe(true);
    expect(duringMutation!.some((entry) => entry.startsWith("workspace:"))).toBe(true);
    expect(duringMutation!.includes("release-task")).toBe(false);
    expect(duringMutation!.includes("release-workspace")).toBe(false);
    void ({} as TaskMutationLease | undefined);
  });
});
