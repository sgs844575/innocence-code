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
    // The corrupt line and the following record are written RAW: a later
    // complete record makes the corrupt line NON-final, which must surface.
    await repository.storage.storage.appendFile(
      "events.jsonl",
      "{not-json}\n" + JSON.stringify({ type: "taskStatus", status: "running", eventId: "e2" }) + "\n",
    );
    await expect(repository.list()).rejects.toThrow(TaskRecoveryError);
    await expect(repository.recoverEventLog()).rejects.toBeInstanceOf(TaskRecoveryError);
  });

  it("treats a fresh repository without a log as empty, not as corruption", async () => {
    const repository = await openTaskRepository(base, "task_rec3");
    expect(await repository.list()).toEqual([]);
    expect(await repository.recoverEventLog()).toBeNull();
  });

  it("repairs a torn tail BEFORE appending: no event is silently lost", async () => {
    const repository = await openTaskRepository(base, "task_rep1");
    await repository.append([taskCreatedEvent({ taskId: "task_rep1", eventId: "e1" })]);
    // Crash mid-append: torn fragment without a trailing newline.
    await repository.storage.storage.appendFile("events.jsonl", '{"type":"taskSta');
    // Without repair, this append would merge into the torn fragment and be
    // swallowed as a (tolerated) truncated tail.
    await repository.append([{ type: "taskStatus", status: "running", eventId: "e2" }]);

    const events = await repository.list();
    expect(events.map((event) => event.type)).toEqual(["taskCreated", "taskStatus"]);
    const recovery = await repository.recoverEventLog();
    expect(recovery!.truncatedTail).toBe(false);
    expect(recovery!.lastCommittedEventId).toBe("e2");
  });

  it("keeps the log recoverable across multiple appends after a torn tail", async () => {
    const repository = await openTaskRepository(base, "task_rep2");
    await repository.append([taskCreatedEvent({ taskId: "task_rep2", eventId: "e1" })]);
    await repository.storage.storage.appendFile("events.jsonl", '{"type":"taskSta');
    await repository.append([{ type: "taskStatus", status: "running", eventId: "e2" }]);
    // A second append must not turn the (already repaired) log non-final-corrupt.
    await repository.append([{ type: "taskStatus", status: "paused", eventId: "e3" }]);

    const events = await repository.list();
    expect(events.map((event) => event.type)).toEqual(["taskCreated", "taskStatus", "taskStatus"]);
    const recovery = await repository.recoverEventLog();
    expect(recovery!.truncatedTail).toBe(false);
    expect(recovery!.lastCommittedEventId).toBe("e3");
    // The raw file has no stray fragment: every physical line parses.
    const raw = await repository.storage.storage.readTextFile("events.jsonl");
    for (const line of raw.split("\n")) {
      if (line.trim() !== "") {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("terminates a complete final record that lacks its newline before appending", async () => {
    const repository = await openTaskRepository(base, "task_rep3");
    await repository.append([taskCreatedEvent({ taskId: "task_rep3", eventId: "e1" })]);
    // Complete JSON, but no trailing newline: an append would merge two records.
    await repository.storage.storage.appendFile("events.jsonl", JSON.stringify({ type: "taskStatus", status: "review" }));
    await repository.append([{ type: "taskStatus", status: "running", eventId: "e2" }]);
    const events = await repository.list();
    expect(events.map((event) => event.type)).toEqual(["taskCreated", "taskStatus", "taskStatus"]);
  });

  it("refuses to append onto a corrupt log (fail closed)", async () => {
    // (a) newline-terminated corrupt FINAL line: not a plausible torn append
    //     of this writer, so repair refuses instead of silently cutting it.
    const repository = await openTaskRepository(base, "task_rep4");
    await repository.append([taskCreatedEvent({ taskId: "task_rep4", eventId: "e1" })]);
    await repository.storage.storage.appendFile("events.jsonl", "{not-json}\n");
    await expect(repository.append([{ type: "taskStatus", status: "running", eventId: "e2" }])).rejects.toBeInstanceOf(
      TaskRecoveryError,
    );
    // The refused append left the file untouched (reads still tolerate the
    // malformed final line as a truncated tail).
    expect((await repository.list()).map((event) => event.type)).toEqual(["taskCreated"]);

    // (b) genuinely NON-final corruption (raw write after a complete record).
    const repository2 = await openTaskRepository(base, "task_rep5");
    await repository2.append([taskCreatedEvent({ taskId: "task_rep5", eventId: "e1" })]);
    await repository2.storage.storage.appendFile(
      "events.jsonl",
      "{not-json}\n" + JSON.stringify({ type: "taskStatus", status: "running" }) + "\n",
    );
    await expect(repository2.append([{ type: "taskStatus", status: "paused" }])).rejects.toBeInstanceOf(
      TaskRecoveryError,
    );
    await expect(repository2.list()).rejects.toBeInstanceOf(TaskRecoveryError);
  });
});
