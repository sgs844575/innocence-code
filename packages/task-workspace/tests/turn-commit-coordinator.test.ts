import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createCheckpoint,
  reduceTask,
  taskCreatedEvent,
  toTaskHead,
  type TaskIdClock,
} from "@innocencecode/task-core";
import { openTaskRepository, type TaskRepository } from "../src/task-repository.ts";
import { sha256Bytes } from "../src/content-store.ts";
import {
  createTurnCommitCoordinator,
  type TranscriptSink,
  type TranscriptTurnRecord,
  type TurnCommitBoundary,
  type TurnCommitInput,
  type TurnMutationContext,
  type TurnRecoveryBoundary,
} from "../src/turn-commit-coordinator.ts";

/** In-memory v3-only transcript sink with quarantine bookkeeping. */
class MemoryTranscriptSink implements TranscriptSink {
  readonly turns: TranscriptTurnRecord[] = [];
  readonly quarantined: TranscriptTurnRecord[] = [];

  async appendTurn(record: TranscriptTurnRecord): Promise<void> {
    this.turns.push({ ...record, messages: [...record.messages] });
  }

  async listTurns(): Promise<readonly TranscriptTurnRecord[]> {
    return this.turns.map((turn) => ({ ...turn, messages: [...turn.messages] }));
  }

  async quarantineTurn(turnId: string): Promise<void> {
    const index = this.turns.findIndex((turn) => turn.turnId === turnId);
    if (index >= 0) {
      const [moved] = this.turns.splice(index, 1);
      this.quarantined.push(moved!);
    }
  }

  /** Test helper: simulates a lost transcript line (e.g. host file damage). */
  async dropTurn(turnId: string): Promise<void> {
    const index = this.turns.findIndex((turn) => turn.turnId === turnId);
    if (index >= 0) this.turns.splice(index, 1);
  }
}

function sequenceClock(): TaskIdClock {
  let seq = 0;
  return {
    newId: (prefix?: string) => `${prefix ?? "id"}-${++seq}`,
    now: () => "2026-08-20T00:00:00.000Z",
  };
}

const failAt = (boundary: TurnCommitBoundary) => ({
  beforeWrite: (hit: TurnCommitBoundary) => {
    if (hit === boundary) {
      throw new Error(`injected fault at ${hit}`);
    }
  },
});

const failRecoveryAt = (boundary: TurnRecoveryBoundary) => ({
  beforeWrite: (hit: TurnRecoveryBoundary) => {
    if (hit === boundary) {
      throw new Error(`injected fault at ${hit}`);
    }
  },
});

let base: string;
let taskSeq = 0;

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-tws-turncommit-"));
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

interface Harness {
  taskId: string;
  repository: TaskRepository;
  transcript: MemoryTranscriptSink;
  coordinator: ReturnType<typeof createTurnCommitCoordinator>;
  context: TurnMutationContext;
  content: Uint8Array;
  checkpoint: ReturnType<typeof createCheckpoint>;
  input: () => TurnCommitInput;
}

async function setup(): Promise<Harness> {
  const taskId = `task_tc${(taskSeq += 1)}`;
  const clock = sequenceClock();
  const repository = await openTaskRepository(base, taskId);
  const created = taskCreatedEvent({
    clock,
    taskId,
    sessionId: "session-1",
    routeId: "route_1",
    baselineCheckpointId: "cp_base",
  });
  await repository.append([created]);
  await repository.writeTaskHead(toTaskHead(reduceTask([created])));

  const transcript = new MemoryTranscriptSink();
  const coordinator = createTurnCommitCoordinator({ repository, transcript, clock });
  const context: TurnMutationContext = { taskId, routeId: "route_1", leaseToken: Symbol("lease") };

  const content = new TextEncoder().encode("file-a-content");
  const checkpoint = createCheckpoint({
    checkpointId: "cp_turn",
    taskId,
    routeId: "route_1",
    turnId: "turn_1",
    files: [{ path: "a.txt", exists: true, hash: sha256Bytes(content), mode: 0o644, binary: false }],
  });
  const input = (): TurnCommitInput => ({
    turnId: "turn_1",
    checkpointId: "cp_turn",
    parentTurnId: null,
    checkpoint,
    objects: [content],
    messages: [{ role: "user", parts: [{ type: "text", text: "问" }] }],
  });
  return { taskId, repository, transcript, coordinator, context, content, checkpoint, input };
}

describe("TurnCommitCoordinator commit sequence", () => {
  it("commits a turn through the exact five-boundary order", async () => {
    const { repository, transcript, coordinator, context, content, checkpoint, input } = await setup();
    const boundaries: TurnCommitBoundary[] = [];
    const result = await coordinator.commitTurn(context, input(), {
      beforeWrite: (boundary) => {
        boundaries.push(boundary);
      },
    });
    expect(boundaries).toEqual([
      "checkpointPersist",
      "turnPrepared",
      "transcript",
      "turnCommitted",
      "taskHead",
    ]);

    // Step 1: objects + checkpoint manifest are durable.
    expect(await repository.readCheckpoint("cp_turn")).toEqual(checkpoint);
    expect(await repository.objects.has(sha256Bytes(content))).toBe(true);

    // Steps 2/4: task events in the fixed order.
    const events = await repository.list();
    expect(events.map((event) => event.type)).toEqual(["taskCreated", "turnPrepared", "turnCommitted"]);
    expect(events[1]).toMatchObject({
      type: "turnPrepared",
      turnId: "turn_1",
      checkpointId: "cp_turn",
      routeId: "route_1",
      eventId: result.preparedEventId,
    });
    expect(events[2]).toMatchObject({
      type: "turnCommitted",
      turnId: "turn_1",
      checkpointId: "cp_turn",
      routeId: "route_1",
      eventId: result.committedEventId,
    });

    // Step 3: transcript v3 line references the prepared event.
    expect(transcript.turns).toHaveLength(1);
    expect(transcript.turns[0]).toMatchObject({
      turnId: "turn_1",
      eventId: result.preparedEventId,
      checkpointId: "cp_turn",
      routeId: "route_1",
      parentTurnId: null,
    });

    // Step 5: atomic task head advanced to the committed event.
    expect((await repository.readTaskHead())?.lastCommittedEventId).toBe(result.committedEventId);

    // Only committed turns are visible; messages pass through unmodified.
    const visible = await coordinator.committedTurns();
    expect(visible.map((turn) => turn.turnId)).toEqual(["turn_1"]);
    expect(visible[0]?.messages).toEqual(input().messages);
    expect(visible[0]?.checkpointId).toBe("cp_turn");
  });

  it("refuses contextless or mismatched mutation and writes nothing", async () => {
    const { repository, transcript, coordinator, input, taskId } = await setup();
    await expect(coordinator.commitTurn(undefined as never, input())).rejects.toThrow(/TaskMutationContext/);
    await expect(
      coordinator.commitTurn({ taskId, routeId: "route_1", leaseToken: "not-a-symbol" } as never, input()),
    ).rejects.toThrow(/TaskMutationContext/);
    await expect(
      coordinator.commitTurn({ taskId: "task_other", routeId: "route_1", leaseToken: Symbol() } as never, input()),
    ).rejects.toThrow(/taskId/);
    await expect(coordinator.recover(undefined as never)).rejects.toThrow(/TaskMutationContext/);

    expect((await repository.list()).map((event) => event.type)).toEqual(["taskCreated"]);
    expect(transcript.turns).toHaveLength(0);
    expect(await repository.readCheckpoint("cp_turn")).toBeNull();
  });

  it.each(["checkpointPersist", "turnPrepared"] as const)(
    "crash before %s leaves nothing recoverable",
    async (boundary) => {
      const { repository, transcript, coordinator, context, input } = await setup();
      await expect(coordinator.commitTurn(context, input(), failAt(boundary))).rejects.toThrow(
        "injected fault",
      );
      expect((await repository.list()).map((event) => event.type)).toEqual(["taskCreated"]);
      expect(transcript.turns).toHaveLength(0);
      const report = await coordinator.recover(context);
      expect(report.actions).toEqual([]);
    },
  );
});

describe("TurnCommitCoordinator recovery classification", () => {
  it("prepared without a transcript is discarded and stays invisible", async () => {
    const { repository, coordinator, context, input } = await setup();
    await expect(coordinator.commitTurn(context, input(), failAt("transcript"))).rejects.toThrow(
      "injected fault",
    );
    expect((await repository.list()).map((event) => event.type)).toEqual(["taskCreated", "turnPrepared"]);

    const report = await coordinator.recover(context);
    expect(report.actions).toEqual([{ kind: "discarded", turnId: "turn_1" }]);
    // Discarding is a classification, not an event append.
    expect((await repository.list()).map((event) => event.type)).toEqual(["taskCreated", "turnPrepared"]);
    expect(await coordinator.committedTurns()).toEqual([]);
  });

  it("transcript without committed backfills turnCommitted after verifying the checkpoint", async () => {
    const { repository, coordinator, context, input } = await setup();
    await expect(coordinator.commitTurn(context, input(), failAt("turnCommitted"))).rejects.toThrow(
      "injected fault",
    );

    const report = await coordinator.recover(context);
    expect(report.actions.map((action) => action.kind)).toEqual(["backfilled"]);

    const events = await repository.list();
    expect(events.map((event) => event.type)).toEqual(["taskCreated", "turnPrepared", "turnCommitted"]);
    const backfill = report.actions[0]!;
    if (backfill.kind !== "backfilled") {
      throw new Error(`expected a backfilled action, got ${backfill.kind}`);
    }
    expect((await repository.readTaskHead())?.lastCommittedEventId).toBe(backfill.committedEventId);
    expect((await coordinator.committedTurns()).map((turn) => turn.turnId)).toEqual(["turn_1"]);
  });

  it.each([
    { how: "missing checkpoint manifest", remove: async (h: Harness) => {
      await h.repository.storage.storage.deleteFile("checkpoints/cp_turn.json");
    } },
    { how: "missing CAS object", remove: async (h: Harness) => {
      await h.repository.storage.storage.deleteFile(`objects/${sha256Bytes(h.content)}`);
    } },
  ])("transcript without committed and an unverifiable checkpoint ($how) quarantines the line", async ({ remove }) => {
    const harness = await setup();
    await expect(
      harness.coordinator.commitTurn(harness.context, harness.input(), failAt("turnCommitted")),
    ).rejects.toThrow("injected fault");
    await remove(harness);

    const report = await harness.coordinator.recover(harness.context);
    expect(report.actions.map((action) => action.kind)).toEqual(["quarantined"]);
    expect(harness.transcript.turns).toHaveLength(0);
    expect(harness.transcript.quarantined.map((turn) => turn.turnId)).toEqual(["turn_1"]);

    const events = await harness.repository.list();
    expect(events.at(-1)).toMatchObject({ type: "taskStatus", status: "checkpoint-failed" });
    expect((await harness.repository.readTaskHead())?.status).toBe("checkpoint-failed");
    expect(await harness.coordinator.committedTurns()).toEqual([]);
  });

  it("committed without the head write heals the head on recovery", async () => {
    const { repository, coordinator, context, input } = await setup();
    await expect(coordinator.commitTurn(context, input(), failAt("taskHead"))).rejects.toThrow(
      "injected fault",
    );
    const events = await repository.list();
    expect(events.map((event) => event.type)).toEqual(["taskCreated", "turnPrepared", "turnCommitted"]);
    expect((await repository.readTaskHead())?.lastCommittedEventId).toBe("event-1"); // stale head

    const report = await coordinator.recover(context);
    expect(report.actions).toEqual([{ kind: "intact", turnId: "turn_1" }]);
    expect((await repository.readTaskHead())?.lastCommittedEventId).toBe(events[2]?.eventId);
    expect((await coordinator.committedTurns()).map((turn) => turn.turnId)).toEqual(["turn_1"]);
  });

  it.each([
    { how: "lost transcript line", damage: async (h: Harness) => h.transcript.dropTurn("turn_1"), hidden: true },
    { how: "missing checkpoint", damage: async (h: Harness) => {
      await h.repository.storage.storage.deleteFile("checkpoints/cp_turn.json");
    }, hidden: false },
  ])("committed without transcript/checkpoint ($how) enters checkpoint-failed", async ({ damage, hidden }) => {
    const harness = await setup();
    await harness.coordinator.commitTurn(harness.context, harness.input());
    await damage(harness);

    const report = await harness.coordinator.recover(harness.context);
    expect(report.actions.map((action) => action.kind)).toEqual(["checkpoint-failed"]);
    const events = await harness.repository.list();
    expect(events.at(-1)).toMatchObject({ type: "taskStatus", status: "checkpoint-failed" });
    expect((await harness.repository.readTaskHead())?.status).toBe("checkpoint-failed");
    // Visibility is phase-based: a committed turn stays visible unless its
    // transcript line is gone; the broken checkpoint is flagged on the task.
    expect(await harness.coordinator.committedTurns()).toEqual(hidden ? [] : [expect.objectContaining({ turnId: "turn_1" })]);
  });

  it("recovery is idempotent: a clean second run appends nothing", async () => {
    const { repository, coordinator, context, input } = await setup();
    await coordinator.commitTurn(context, input());
    const first = await coordinator.recover(context);
    expect(first.actions).toEqual([{ kind: "intact", turnId: "turn_1" }]);
    const second = await coordinator.recover(context);
    expect(second.actions).toEqual([{ kind: "intact", turnId: "turn_1" }]);
    expect((await repository.list()).map((event) => event.type)).toEqual([
      "taskCreated",
      "turnPrepared",
      "turnCommitted",
    ]);
  });

  it("repeated recovery of a checkpoint-failed turn appends no new events", async () => {
    const harness = await setup();
    await harness.coordinator.commitTurn(harness.context, harness.input());
    await harness.transcript.dropTurn("turn_1");

    await harness.coordinator.recover(harness.context);
    const eventsAfterFirst = (await harness.repository.list()).length;
    const second = await harness.coordinator.recover(harness.context);
    expect(second.actions.map((action) => action.kind)).toEqual(["checkpoint-failed"]);
    expect(await harness.repository.list()).toHaveLength(eventsAfterFirst);
    expect((await harness.repository.readTaskHead())?.status).toBe("checkpoint-failed");
  });

  it("a torn turnCommitted append is repaired on backfill and stays visible after restart", async () => {
    const harness = await setup();
    await expect(
      harness.coordinator.commitTurn(harness.context, harness.input(), failAt("turnCommitted")),
    ).rejects.toThrow("injected fault");
    // Simulate a torn turnCommitted append: partial JSON, no trailing newline.
    const torn = JSON.stringify({
      type: "turnCommitted",
      eventId: "event-torn",
      turnId: "turn_1",
      checkpointId: "cp_turn",
      routeId: "route_1",
    }).slice(0, 30);
    await harness.repository.storage.storage.appendFile("events.jsonl", torn);

    const report = await harness.coordinator.recover(harness.context);
    expect(report.actions.map((action) => action.kind)).toEqual(["backfilled"]);

    // Fresh-process view of the SAME storage: the backfilled event is durable
    // and the turn is visible — no unilateral completion.
    const repository2 = await openTaskRepository(base, harness.taskId);
    const coordinator2 = createTurnCommitCoordinator({
      repository: repository2,
      transcript: harness.transcript,
      clock: sequenceClock(),
    });
    const events = await repository2.list();
    expect(events.map((event) => event.type)).toEqual(["taskCreated", "turnPrepared", "turnCommitted"]);
    expect((await coordinator2.committedTurns()).map((turn) => turn.turnId)).toEqual(["turn_1"]);

    // Idempotent: the next recovery does NOT re-append another committed event.
    const second = await coordinator2.recover(harness.context);
    expect(second.actions.map((action) => action.kind)).toEqual(["intact"]);
    expect((await repository2.list()).map((event) => event.type)).toEqual([
      "taskCreated",
      "turnPrepared",
      "turnCommitted",
    ]);
  });

  it("refuses to backfill a transcript line whose eventId does not correlate with turnPrepared", async () => {
    const harness = await setup();
    await expect(
      harness.coordinator.commitTurn(harness.context, harness.input(), failAt("turnCommitted")),
    ).rejects.toThrow("injected fault");
    // Tamper the transcript line so it no longer references the prepared event.
    harness.transcript.turns[0] = {
      ...harness.transcript.turns[0]!,
      eventId: "event-from-another-attempt",
    };

    const report = await harness.coordinator.recover(harness.context);
    expect(report.actions.map((action) => action.kind)).toEqual(["quarantined"]);
    expect((await harness.repository.readTaskHead())?.status).toBe("checkpoint-failed");
    expect(harness.transcript.quarantined.map((turn) => turn.turnId)).toEqual(["turn_1"]);
  });

  it("orders recovery writes: failed status and head are durable BEFORE the destructive quarantine", async () => {
    const harness = await setup();
    await expect(
      harness.coordinator.commitTurn(harness.context, harness.input(), failAt("turnCommitted")),
    ).rejects.toThrow("injected fault");
    await harness.repository.storage.storage.deleteFile("checkpoints/cp_turn.json");

    // Crash exactly at the quarantine boundary: durable writes already landed.
    await expect(harness.coordinator.recover(harness.context, failRecoveryAt("quarantine"))).rejects.toThrow(
      "injected fault",
    );
    const events = await harness.repository.list();
    expect(events.at(-1)).toMatchObject({ type: "taskStatus", status: "checkpoint-failed" });
    expect((await harness.repository.readTaskHead())?.status).toBe("checkpoint-failed");
    // The transcript line is still present, so the next recovery re-classifies
    // the turn as quarantinable — it can never degrade into "discarded".
    expect(harness.transcript.turns).toHaveLength(1);

    const report = await harness.coordinator.recover(harness.context);
    expect(report.actions.map((action) => action.kind)).toEqual(["quarantined"]);
    expect(harness.transcript.quarantined.map((turn) => turn.turnId)).toEqual(["turn_1"]);
    // Exactly one checkpoint-failed status across both passes (idempotent).
    const statuses = (await harness.repository.list()).filter((event) => event.type === "taskStatus");
    expect(statuses).toHaveLength(1);
  });

  it.each([
    { boundary: "backfill" as const, expected: ["backfilled"] },
    { boundary: "failedStatus" as const, expected: ["quarantined"] },
  ])("fault injection at recovery's own $boundary write leaves nothing half-done", async ({ boundary, expected }) => {
    const harness = await setup();
    await expect(
      harness.coordinator.commitTurn(harness.context, harness.input(), failAt("turnCommitted")),
    ).rejects.toThrow("injected fault");
    if (boundary === "failedStatus") {
      // Make the checkpoint unverifiable so recovery wants a failed status.
      await harness.repository.storage.storage.deleteFile("checkpoints/cp_turn.json");
    }

    await expect(harness.coordinator.recover(harness.context, failRecoveryAt(boundary))).rejects.toThrow(
      "injected fault",
    );
    // The crash left the log untouched (no append, no head flip, no quarantine).
    expect((await harness.repository.list()).map((event) => event.type)).toEqual(["taskCreated", "turnPrepared"]);
    expect(harness.transcript.turns).toHaveLength(1);
    expect(harness.transcript.quarantined).toHaveLength(0);
    expect((await harness.repository.readTaskHead())?.status).toBe("ready");

    // A clean re-run completes the intended classification.
    const report = await harness.coordinator.recover(harness.context);
    expect(report.actions.map((action) => action.kind)).toEqual(expected);
  });
});

describe("task layout", () => {
  it("creates the artifacts directory of the fixed task layout", async () => {
    const taskId = `task_layout${(taskSeq += 1)}`;
    await openTaskRepository(base, taskId);
    expect((await fs.stat(path.join(base, "tasks", taskId, "artifacts"))).isDirectory()).toBe(true);
  });
});
