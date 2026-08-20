/**
 * TurnCommitCoordinator: the fixed persistence order that makes one
 * conversation turn durable (P1 plan, task 5):
 *
 *   objects/checkpoint manifest
 *     -> append task event { type: turnPrepared, eventId, turnId, checkpointId, routeId }
 *     -> append transcript turn-v3 { eventId, turnId, checkpointId, routeId, parentTurnId }
 *     -> append task event { type: turnCommitted, eventId, turnId, checkpointId, routeId }
 *     -> atomic task head write
 *
 * The caller acquires the TaskMutationContext (task lease; workspace lease too
 * when files were written) BEFORE calling and holds it until commitTurn
 * resolves: the coordinator only receives the context — there is no
 * contextless mutation path, at the type level or at runtime.
 *
 * Only turnCommitted turns are visible: committedTurns filters
 * prepared-but-uncommitted turns out of the UI/Agent history view.
 *
 * Crash recovery (recover) classifies each turn from the replayed event log
 * joined with the transcript sink and the checkpoint store:
 * - prepared, no transcript line            -> discarded (stays invisible; no writes)
 * - transcript line, no committed event     -> the line must correlate with the
 *                                              turn's turnPrepared eventId AND the
 *                                              checkpoint must verify, then committed
 *                                              is backfilled, ELSE the transcript line
 *                                              is quarantined and the task enters
 *                                              checkpoint-failed
 * - committed, transcript/checkpoint absent -> checkpoint-failed
 * Write ORDER inside recovery is durability-first: backfill/failed-status
 * events, then the atomic task head, and only then the destructive transcript
 * quarantine — a crash before the quarantine is retried idempotently by the
 * next recovery instead of degrading the turn to "discarded". Appends repair
 * a torn log tail first (see event-log.ts), so no write is ever merged into
 * a torn fragment. The contract types live in turn-commit-ports.ts.
 */
import {
  createNodeIdClock,
  reduceTask,
  taskStatusEvent,
  toTaskHead,
  turnCommittedEvent,
  turnPreparedEvent,
  type TaskEvent,
  type TaskHead,
  type TaskIdClock,
  type TaskRecoveryResult,
} from "@innocencecode/task-core";
import type { TaskRepository } from "./task-repository.ts";
import type {
  CommittedTurnView,
  TranscriptSink,
  TurnCommitCoordinator,
  TurnCommitInput,
  TurnCommitResult,
  TurnMutationContext,
  TurnRecoveryAction,
  TurnRecoveryReport,
} from "./turn-commit-ports.ts";

export * from "./turn-commit-ports.ts";

function assertMutationContext(repository: TaskRepository, context: TurnMutationContext | undefined): TurnMutationContext {
  if (
    typeof context !== "object" ||
    context === null ||
    typeof context.taskId !== "string" ||
    typeof context.routeId !== "string" ||
    typeof context.leaseToken !== "symbol"
  ) {
    throw new Error(
      "turn commit requires a TaskMutationContext acquired from the task runtime (taskId, routeId, symbol leaseToken)",
    );
  }
  if (context.taskId !== repository.storage.taskId) {
    throw new Error(
      `mutation context taskId ${JSON.stringify(context.taskId)} does not match repository task ${JSON.stringify(repository.storage.taskId)}`,
    );
  }
  return context;
}

function assertCommitInput(input: TurnCommitInput): void {
  if (typeof input.turnId !== "string" || input.turnId.length === 0) {
    throw new Error("turn commit requires a non-empty turnId");
  }
  if (typeof input.checkpointId !== "string" || input.checkpointId.length === 0) {
    throw new Error("turn commit requires a non-empty checkpointId");
  }
  if (typeof input.checkpoint !== "object" || input.checkpoint.checkpointId !== input.checkpointId) {
    throw new Error("turn commit checkpoint.checkpointId must match checkpointId");
  }
  if (!Array.isArray(input.messages)) {
    throw new Error("turn commit requires a messages array");
  }
}

/**
 * eventId of the turnPrepared event that prepared `turnId` (at most one can
 * exist — reduceTask rejects duplicates). Null when the raw log record
 * omitted its envelope eventId, in which case correlation falls back to
 * turnId + checkpointId matching.
 */
function preparedEventIdOf(events: readonly TaskEvent[], turnId: string): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event !== undefined && event.type === "turnPrepared" && event.turnId === turnId) {
      return event.eventId ?? null;
    }
  }
  return null;
}

export function createTurnCommitCoordinator(deps: {
  repository: TaskRepository;
  transcript: TranscriptSink;
  clock?: TaskIdClock;
}): TurnCommitCoordinator {
  const repository = deps.repository;
  const transcript = deps.transcript;
  const clock = deps.clock ?? createNodeIdClock();

  /** A checkpoint is verifiable when its manifest reads AND every hashed file's object exists. */
  async function verifyCheckpoint(checkpointId: string): Promise<boolean> {
    const checkpoint = await repository.readCheckpoint(checkpointId);
    if (checkpoint === null) {
      return false;
    }
    for (const file of checkpoint.files) {
      if (file.hash !== null && !(await repository.objects.has(file.hash))) {
        return false;
      }
    }
    return true;
  }

  /** Re-reduces the log plus `appended` (persisting them) to the head fields only. */
  async function replayWith(appended: readonly TaskEvent[]): Promise<TaskHead> {
    const recovery = await repository.recoverEventLog();
    if (recovery === null) {
      throw new Error("turn commit: task event log is missing (taskCreated was never persisted)");
    }
    if (appended.length === 0) {
      return toTaskHead(recovery);
    }
    const state = reduceTask([...recovery.recoveredEvents, ...appended]);
    await repository.append(appended);
    return toTaskHead(state);
  }

  return {
    async commitTurn(context, input, options = {}): Promise<TurnCommitResult> {
      const ctx = assertMutationContext(repository, context);
      assertCommitInput(input);
      const beforeWrite = options.beforeWrite;

      // Step 1: objects + checkpoint manifest (CAS puts, then the manifest that references them).
      await beforeWrite?.("checkpointPersist");
      for (const content of input.objects ?? []) {
        await repository.objects.put(content);
      }
      await repository.writeCheckpoint(input.checkpoint);

      // Step 2: task event turnPrepared.
      await beforeWrite?.("turnPrepared");
      const prepared = turnPreparedEvent({
        clock,
        at: input.at,
        turnId: input.turnId,
        checkpointId: input.checkpointId,
        routeId: ctx.routeId,
      });
      await repository.append([prepared]);

      // Step 3: transcript turn-v3 (references the prepared event id).
      await beforeWrite?.("transcript");
      await transcript.appendTurn({
        at: prepared.at ?? clock.now(),
        eventId: prepared.eventId ?? clock.newId("event"),
        turnId: input.turnId,
        routeId: ctx.routeId,
        parentTurnId: input.parentTurnId,
        checkpointId: input.checkpointId,
        messages: input.messages,
      });

      // Step 4: task event turnCommitted.
      await beforeWrite?.("turnCommitted");
      const committed = turnCommittedEvent({
        clock,
        at: input.at,
        turnId: input.turnId,
        checkpointId: input.checkpointId,
        routeId: ctx.routeId,
      });
      await repository.append([committed]);

      // Step 5: atomic task head from the replayed log.
      await beforeWrite?.("taskHead");
      await repository.writeTaskHead(await replayWith([]));

      return {
        turnId: input.turnId,
        checkpointId: input.checkpointId,
        preparedEventId: prepared.eventId ?? "",
        committedEventId: committed.eventId ?? "",
      };
    },

    async recover(context, options = {}): Promise<TurnRecoveryReport> {
      assertMutationContext(repository, context);
      const recovery: TaskRecoveryResult | null = await repository.recoverEventLog();
      if (recovery === null) {
        throw new Error("turn recovery: task event log is missing (taskCreated was never persisted)");
      }
      const beforeWrite = options.beforeWrite;
      const transcriptTurns = await transcript.listTurns();
      const byTurnId = new Map(transcriptTurns.map((turn) => [turn.turnId, turn]));
      const actions: TurnRecoveryAction[] = [];
      const appended: TaskEvent[] = [];
      // Destructive sink side effects are DEFERRED until every durable write
      // (event appends + task head) has landed. A crash before a quarantine
      // leaves the transcript line in place, so the next recovery still sees
      // prepared + transcript and re-classifies; quarantining first would make
      // the turn indistinguishable from "discarded" and un-backfillable.
      const pendingQuarantines: string[] = [];
      // One checkpoint-failed status per recovery pass at most, and none when
      // the replayed log already carries it — repeated recovery appends nothing.
      let failedStatusQueued = recovery.status === "checkpoint-failed";
      const queueFailedStatus = async (): Promise<void> => {
        if (!failedStatusQueued) {
          await beforeWrite?.("failedStatus");
          appended.push(taskStatusEvent({ clock, status: "checkpoint-failed" }));
          failedStatusQueued = true;
        }
      };

      for (const turn of recovery.turns.values()) {
        const line = byTurnId.get(turn.turnId);
        if (turn.phase === "prepared") {
          if (line === undefined) {
            // Discarded: the turnId is burned — reduceTask rejects a second
            // turnPrepared for the same turnId, so the caller must mint a
            // fresh turnId for any retry. Never re-prepare this id.
            actions.push({ kind: "discarded", turnId: turn.turnId });
            continue;
          }
          // The transcript line must provably reference THIS turn's prepared
          // event before a backfill may commit it (eventId correlation; a
          // raw log without envelopes falls back to turnId matching).
          const expectedEventId = preparedEventIdOf(recovery.recoveredEvents, turn.turnId);
          const correlates = expectedEventId === null || line.eventId === expectedEventId;
          if (correlates && (await verifyCheckpoint(turn.checkpointId))) {
            await beforeWrite?.("backfill");
            const committed = turnCommittedEvent({
              clock,
              turnId: turn.turnId,
              checkpointId: turn.checkpointId,
              routeId: turn.routeId,
            });
            appended.push(committed);
            actions.push({ kind: "backfilled", turnId: turn.turnId, committedEventId: committed.eventId ?? "" });
          } else {
            await queueFailedStatus();
            pendingQuarantines.push(turn.turnId);
            actions.push({ kind: "quarantined", turnId: turn.turnId });
          }
        } else {
          const intact = line !== undefined && (await verifyCheckpoint(turn.checkpointId));
          if (intact) {
            actions.push({ kind: "intact", turnId: turn.turnId });
          } else {
            await queueFailedStatus();
            actions.push({ kind: "checkpoint-failed", turnId: turn.turnId });
          }
        }
      }

      // Durable writes first: events (the append itself repairs any torn log
      // tail — see event-log.ts), then the atomic task head rewrite.
      const head = await replayWith(appended);
      await beforeWrite?.("taskHead");
      await repository.writeTaskHead(head);
      // Destructive quarantine LAST: a crash here is retried idempotently by
      // the next recovery (status already durable, nothing re-appended).
      for (const turnId of pendingQuarantines) {
        await beforeWrite?.("quarantine");
        await transcript.quarantineTurn(turnId);
      }
      return { actions, head };
    },

    async committedTurns(): Promise<readonly CommittedTurnView[]> {
      const recovery = await repository.recoverEventLog();
      if (recovery === null) {
        return [];
      }
      const transcriptTurns = await transcript.listTurns();
      const visible: CommittedTurnView[] = [];
      for (const turn of transcriptTurns) {
        const phase = recovery.turns.get(turn.turnId);
        if (phase !== undefined && phase.phase === "committed" && phase.checkpointId === turn.checkpointId) {
          visible.push({
            at: turn.at,
            eventId: turn.eventId,
            turnId: turn.turnId,
            routeId: turn.routeId,
            parentTurnId: turn.parentTurnId,
            checkpointId: turn.checkpointId,
            messages: turn.messages,
          });
        }
      }
      return visible;
    },
  };
}
