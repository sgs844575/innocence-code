import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  recoverTask,
  TaskRecoveryError,
  taskCreatedEvent,
  turnCheckpointedEvent,
  turnCommittedEvent,
  turnPreparedEvent,
} from "@innocencecode/task-core";
import { openTaskRepository } from "../src/task-repository.ts";

let base: string;

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-tws-recovery-"));
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const validEvents =
  [
    taskCreatedEvent({
      eventId: "event-1",
      taskId: "task-1",
      sessionId: "session-1",
      routeId: "route_1",
      baselineCheckpointId: "cp_base",
    }),
    turnCheckpointedEvent({ checkpointId: "cp_1", turnId: "turn-1", eventId: "event-2" }),
  ]
    .map((event) => JSON.stringify(event))
    .join("\n") + "\n";

describe("recoverTask over raw event-log text", () => {
  it("ignores a truncated final JSONL record", () => {
    const recovered = recoverTask(validEvents + '{"type":"turnCheckpointed"');
    expect(recovered.lastCommittedEventId).toBe("event-2");
    expect(recovered.truncatedTail).toBe(true);
    expect(recovered.recoveredEvents.map((event) => event.type)).toEqual(["taskCreated", "turnCheckpointed"]);
  });

  it("replays cleanly when the log has no truncated tail", () => {
    const recovered = recoverTask(validEvents);
    expect(recovered.truncatedTail).toBe(false);
    expect(recovered.lastCommittedEventId).toBe("event-2");
    expect(recovered.status).toBe("ready");
  });

  it("surfaces a malformed NON-final line as a structured TaskRecoveryError", () => {
    const raw =
      validEvents +
      "{broken json\n" +
      JSON.stringify({ type: "taskStatus", status: "running", eventId: "event-3" }) +
      "\n";
    try {
      recoverTask(raw);
      throw new Error("expected recoverTask to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskRecoveryError);
      const recovery = error as TaskRecoveryError;
      expect(recovery.kind).toBe("incomplete-event");
      expect(recovery.eventIndex).toBe(2);
      expect(recovery.message).toContain("incomplete-event");
    }
  });

  it("replays turn lifecycle events and exposes per-turn phases", () => {
    const events = [
      taskCreatedEvent({ eventId: "e0", taskId: "task-2", routeId: "r0", baselineCheckpointId: "c0" }),
      turnPreparedEvent({ eventId: "e1", turnId: "turn-1", checkpointId: "cp-1", routeId: "r0" }),
      turnCommittedEvent({ eventId: "e2", turnId: "turn-1", checkpointId: "cp-1", routeId: "r0" }),
      turnPreparedEvent({ eventId: "e3", turnId: "turn-2", checkpointId: "cp-2", routeId: "r0" }),
    ];
    const recovered = recoverTask(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    expect(recovered.turns.get("turn-1")?.phase).toBe("committed");
    expect(recovered.turns.get("turn-2")?.phase).toBe("prepared");
    expect(recovered.lastCommittedEventId).toBe("e3");
  });

  it("rejects an empty log with a structured error", () => {
    expect(() => recoverTask("")).toThrow(TaskRecoveryError);
    expect(() => recoverTask("\n  \n")).toThrow(TaskRecoveryError);
  });
});

describe("file-backed event log recovery", () => {
  it("ignores a truncated final append and keeps listing complete events", async () => {
    const repository = await openTaskRepository(base, "task_rec1");
    await repository.append([taskCreatedEvent({ taskId: "task_rec1", eventId: "e1" })]);
    // Crash mid-append: partial JSON, no trailing newline.
    await repository.storage.storage.appendFile("events.jsonl", '{"type":"turnCheckpointed"');

    expect((await repository.list()).map((event) => event.type)).toEqual(["taskCreated"]);
    const recovery = await repository.recoverEventLog();
    expect(recovery).not.toBeNull();
    expect(recovery!.truncatedTail).toBe(true);
    expect(recovery!.lastCommittedEventId).toBe("e1");
  });

  it("surfaces a corrupt mid-file line through list() instead of skipping it", async () => {
    const repository = await openTaskRepository(base, "task_rec2");
    await repository.append([taskCreatedEvent({ taskId: "task_rec2", eventId: "e1" })]);
    await repository.storage.storage.appendFile("events.jsonl", "{not-json}\n");
    await repository.append([{ type: "taskStatus", status: "running", eventId: "e2" }]);
    await expect(repository.list()).rejects.toThrow(TaskRecoveryError);
    await expect(repository.recoverEventLog()).rejects.toBeInstanceOf(TaskRecoveryError);
  });

  it("treats a fresh repository without a log as empty, not as corruption", async () => {
    const repository = await openTaskRepository(base, "task_rec3");
    expect(await repository.list()).toEqual([]);
    expect(await repository.recoverEventLog()).toBeNull();
  });
});
