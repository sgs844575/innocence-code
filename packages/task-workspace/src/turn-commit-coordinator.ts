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
 * - transcript line, no committed event     -> checkpoint verified then committed is
 *                                              backfilled, ELSE the transcript line is
 *                                              quarantined and the task enters
 *                                              checkpoint-failed
 * - committed, transcript/checkpoint absent -> checkpoint-failed
 * The task head is always rewritten from the replayed state, healing a crash
 * between the committed event and the head write. The contract types live in
 * turn-commit-ports.ts.
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

    async recover(context): Promise<TurnRecoveryReport> {
      assertMutationContext(repository, context);
      const recovery: TaskRecoveryResult | null = await repository.recoverEventLog();
      if (recovery === null) {
        throw new Error("turn recovery: task event log is missing (taskCreated was never persisted)");
      }
      const transcriptTurns = await transcript.listTurns();
      const byTurnId = new Map(transcriptTurns.map((turn) => [turn.turnId, turn]));
      const actions: TurnRecoveryAction[] = [];
      const appended: TaskEvent[] = [];
      // One checkpoint-failed status per recovery pass at most, and none when
      // the replayed log already carries it — repeated recovery appends nothing.
      let failedStatusQueued = recovery.status === "checkpoint-failed";
      const queueFailedStatus = () => {
        if (!failedStatusQueued) {
          appended.push(taskStatusEvent({ clock, status: "checkpoint-failed" }));
          failedStatusQueued = true;
        }
      };

      for (const turn of recovery.turns.values()) {
        const line = byTurnId.get(turn.turnId);
        if (turn.phase === "prepared") {
          if (line === undefined) {
            actions.push({ kind: "discarded", turnId: turn.turnId });
          } else if (await verifyCheckpoint(turn.checkpointId)) {
            const committed = turnCommittedEvent({
              clock,
              turnId: turn.turnId,
              checkpointId: turn.checkpointId,
              routeId: turn.routeId,
            });
            appended.push(committed);
            actions.push({ kind: "backfilled", turnId: turn.turnId, committedEventId: committed.eventId ?? "" });
          } else {
            await transcript.quarantineTurn(turn.turnId);
            queueFailedStatus();
            actions.push({ kind: "quarantined", turnId: turn.turnId });
          }
        } else {
          const intact = line !== undefined && (await verifyCheckpoint(turn.checkpointId));
          if (intact) {
            actions.push({ kind: "intact", turnId: turn.turnId });
          } else {
            queueFailedStatus();
            actions.push({ kind: "checkpoint-failed", turnId: turn.turnId });
          }
        }
      }

      const head = await replayWith(appended);
      await repository.writeTaskHead(head);
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
