import { describe, expect, it } from "vitest";
import {
  createRoute,
  reduceTask,
  routeAttachedEvent,
  TaskRecoveryError,
  taskCreatedEvent,
  taskStatusEvent,
  turnCheckpointedEvent,
  type TaskEvent,
} from "../src/index";

function captureRecovery(act: () => unknown): TaskRecoveryError {
  try {
    act();
  } catch (error) {
    if (error instanceof TaskRecoveryError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected reduceTask to throw a TaskRecoveryError");
}

describe("reduceTask replay", () => {
  it("replays a truncated event log to the last complete event", () => {
    const state = reduceTask([
      taskCreatedEvent(),
      turnCheckpointedEvent({ checkpointId: "c1" }),
      { type: "taskStatus", status: "running" },
    ]);
    expect(state.status).toBe("running");
  });

  it("tracks the last committed event id and ignores envelope-less raw events", () => {
    const state = reduceTask([
      taskCreatedEvent({
        eventId: "e1",
        taskId: "t1",
        sessionId: "s1",
        routeId: "r0",
        baselineCheckpointId: "c0",
      }),
      taskStatusEvent({ status: "paused", eventId: "e2" }),
      { type: "taskStatus", status: "completed" },
    ]);
    expect(state.status).toBe("completed");
    expect(state.lastCommittedEventId).toBe("e2");
  });

  it("records turn checkpoints on the active route", () => {
    const state = reduceTask([
      taskCreatedEvent({ taskId: "t1", routeId: "r0", baselineCheckpointId: "c0" }),
      turnCheckpointedEvent({
        checkpointId: "c1",
        turnId: "turn-1",
        files: [{ path: "src/a.ts", exists: true, hash: "h1", mode: 0o644, binary: false }],
      }),
    ]);
    expect(state.checkpoints.get("c1")).toMatchObject({
      checkpointId: "c1",
      taskId: "t1",
      routeId: "r0",
      turnId: "turn-1",
    });
    expect(state.checkpoints.get("c1")?.files).toHaveLength(1);
    expect(state.routes.get("r0")).toMatchObject({
      routeId: "r0",
      parentRouteId: null,
      checkpointId: "c0",
    });
  });

  it("switches the active route on routeAttached", () => {
    const fork = createRoute({ routeId: "r1", parentRouteId: "r0", checkpointId: "c1", forkTurnId: "turn-1" });
    const state = reduceTask([
      taskCreatedEvent({ routeId: "r0", baselineCheckpointId: "c0" }),
      routeAttachedEvent({ route: fork, eventId: "e2" }),
    ]);
    expect(state.activeRouteId).toBe("r1");
    // The factory copies the route into the event instead of aliasing it.
    expect(state.routes.get("r1")).toEqual(fork);
    expect(state.lastCommittedEventId).toBe("e2");
  });

  it("propagates route cycle errors from cyclic routeAttached events", () => {
    const cyclic = createRoute({ routeId: "r1", parentRouteId: "r0", checkpointId: "c1" });
    expect(() =>
      reduceTask([
        taskCreatedEvent({ routeId: "r0", baselineCheckpointId: "c0" }),
        routeAttachedEvent({ route: { ...cyclic, parentRouteId: "r1" } }),
      ]),
    ).toThrow("route cycle");
  });

  it("round-trips events through JSON", () => {
    const events = [
      taskCreatedEvent({ eventId: "e1", taskId: "t1", routeId: "r0", baselineCheckpointId: "c0" }),
      turnCheckpointedEvent({ checkpointId: "c1", turnId: "turn-1", eventId: "e2" }),
      taskStatusEvent({ status: "review", eventId: "e3" }),
    ];
    const parsed = JSON.parse(JSON.stringify(events)) as TaskEvent[];
    expect(parsed[0]).toEqual(events[0]);
    expect(reduceTask(parsed).status).toBe("review");
  });
});

describe("structured recovery errors", () => {
  it("reports unknown event types with kind, index and rawType", () => {
    const recovery = captureRecovery(() =>
      reduceTask([taskCreatedEvent(), { type: "taskDeleted" } as unknown as TaskEvent]),
    );
    expect(recovery.kind).toBe("unknown-event");
    expect(recovery.eventIndex).toBe(1);
    expect(recovery.rawType).toBe("taskDeleted");
    expect(recovery.reason.length).toBeGreaterThan(0);
    expect(recovery.message).toContain("unknown-event");
  });

  it("reports structurally invalid events as incomplete-event", () => {
    const recovery = captureRecovery(() =>
      reduceTask([taskCreatedEvent(), { type: "taskStatus", status: "bogus" } as unknown as TaskEvent]),
    );
    expect(recovery.kind).toBe("incomplete-event");
    expect(recovery.eventIndex).toBe(1);
    expect(recovery.rawType).toBeUndefined();
    expect(recovery.message).toContain("incomplete-event");
  });

  it("rejects non-object events", () => {
    for (const bad of [null, 42, "taskStatus", []]) {
      const recovery = captureRecovery(() => reduceTask([bad as unknown as TaskEvent]));
      expect(recovery.kind).toBe("incomplete-event");
      expect(recovery.eventIndex).toBe(0);
    }
  });

  it("rejects logs that do not start with taskCreated", () => {
    const recovery = captureRecovery(() => reduceTask([taskStatusEvent({ status: "running" })]));
    expect(recovery.kind).toBe("incomplete-event");
    expect(recovery.reason).toContain("taskCreated");

    const empty = captureRecovery(() => reduceTask([]));
    expect(empty.kind).toBe("incomplete-event");
  });

  it("rejects a duplicated taskCreated", () => {
    const recovery = captureRecovery(() => reduceTask([taskCreatedEvent(), taskCreatedEvent()]));
    expect(recovery.kind).toBe("incomplete-event");
    expect(recovery.eventIndex).toBe(1);
  });

  it("rejects turnCheckpointed without a checkpoint id", () => {
    const recovery = captureRecovery(() =>
      reduceTask([taskCreatedEvent(), { type: "turnCheckpointed" } as unknown as TaskEvent]),
    );
    expect(recovery.kind).toBe("incomplete-event");
    expect(recovery.eventIndex).toBe(1);
    expect(recovery.reason).toContain("checkpointId");
  });
});

describe("event factories", () => {
  it("fills JSON-safe envelopes and defaults", () => {
    const created = taskCreatedEvent();
    expect(created.eventId).toMatch(/^event_/);
    expect(created.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(created.workspaceKind).toBe("snapshot");
    expect(created.mode).toBe("baseline");

    const checkpointed = turnCheckpointedEvent({ checkpointId: "c1" });
    expect(checkpointed.turnId).toBeTruthy();
    expect(checkpointed.routeId).toBeNull();
    expect(checkpointed.files).toEqual([]);
  });

  it("accepts an injected deterministic clock", () => {
    let seq = 0;
    const clock = {
      newId: (prefix?: string) => `${prefix ?? "id"}-${++seq}`,
      now: () => "2026-08-19T00:00:00.000Z",
    };
    const event = taskStatusEvent({ status: "paused", clock });
    expect(event).toEqual({
      type: "taskStatus",
      status: "paused",
      eventId: "event-1",
      at: "2026-08-19T00:00:00.000Z",
    });
  });
});
