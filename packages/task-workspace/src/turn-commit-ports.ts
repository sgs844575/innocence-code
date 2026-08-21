/**
 * Ports and contracts of the turn commit sequence (see turn-commit-coordinator.ts
 * for the orchestration). Split by responsibility so the contract block stays
 * independently readable; task-workspace remains host- and plugin-agnostic.
 */
import type { Checkpoint, TaskHead } from "@innocencecode/task-core";

/**
 * Structural minimal form of plugin-task's TaskMutationContext
 * ({ taskId, routeId, workspaceKey, leaseToken }). task-workspace must not
 * depend on @innocencecode/plugin-task (a horizontal dependency — plugin-task
 * sits on the harness spine), so only the fields this coordinator enforces are
 * declared; a real TaskMutationContext satisfies this interface structurally.
 */
export interface TurnMutationContext {
  readonly taskId: string;
  readonly routeId: string;
  readonly leaseToken: symbol;
}

/**
 * Host-side transcript port for turn-v3 lines. The record shape is
 * field-compatible with harness-electron's TurnRecordV3; `messages` is opaque
 * here (task-workspace never inspects message internals — the host passes
 * Message[] through with full fidelity).
 */
export interface TranscriptTurnRecord {
  readonly at: string;
  readonly eventId: string;
  readonly turnId: string;
  readonly routeId: string;
  readonly parentTurnId: string | null;
  readonly checkpointId: string;
  readonly messages: readonly unknown[];
}

/**
 * Transcript sink port implemented by the host adapter (Task 6+): appends one
 * durable turn-v3 line, lists decoded v3 turns, and QUARANTINES an incomplete
 * line — moving it aside (e.g. a quarantine file next to the transcript) so it
 * never re-enters history while remaining inspectable for forensics.
 */
export interface TranscriptSink {
  appendTurn(record: TranscriptTurnRecord): Promise<void>;
  listTurns(): Promise<readonly TranscriptTurnRecord[]>;
  quarantineTurn(turnId: string): Promise<void>;
}

/** The five write boundaries of the commit sequence, in order. */
export type TurnCommitBoundary =
  | "checkpointPersist"
  | "turnPrepared"
  | "transcript"
  | "turnCommitted"
  | "taskHead";

export interface TurnCommitOptions {
  /**
   * Invoked before each boundary's write; returning a rejected promise or
   * throwing simulates a crash AT that boundary (fault injection), and also
   * serves as an observability hook.
   */
  beforeWrite?: (boundary: TurnCommitBoundary) => void | Promise<void>;
}

export interface TurnCommitInput {
  turnId: string;
  checkpointId: string;
  /** Turn whose fork/parent this turn continues; null on the main route's first turn. */
  parentTurnId: string | null;
  /** Checkpoint manifest to persist in step 1 (its files' content goes to objects). */
  checkpoint: Checkpoint;
  /** File contents CAS-put before the manifest references them. */
  objects?: readonly Uint8Array[];
  /** Conversation of the turn; passed through to the transcript sink opaquely. */
  messages: readonly unknown[];
  at?: string;
}

export interface TurnCommitResult {
  turnId: string;
  checkpointId: string;
  preparedEventId: string;
  committedEventId: string;
}

/** A committed turn as visible to the UI and Agent history. */
export interface CommittedTurnView {
  at: string;
  eventId: string;
  turnId: string;
  routeId: string;
  parentTurnId: string | null;
  checkpointId: string;
  messages: readonly unknown[];
}

export type TurnRecoveryAction =
  | { kind: "discarded"; turnId: string }
  | { kind: "backfilled"; turnId: string; committedEventId: string }
  | { kind: "quarantined"; turnId: string }
  | { kind: "checkpoint-failed"; turnId: string }
  | { kind: "intact"; turnId: string };

export interface TurnRecoveryReport {
  actions: readonly TurnRecoveryAction[];
  /** Final task head after recovery writes (always rewritten atomically). */
  head: TaskHead;
}

export interface TurnCommitCoordinator {
  /** Runs the fixed five-boundary sequence; rejects when any boundary write fails. */
  commitTurn(context: TurnMutationContext, input: TurnCommitInput, options?: TurnCommitOptions): Promise<TurnCommitResult>;
  /** Classifies incomplete turns, heals what it can, and rewrites the task head. */
  recover(context: TurnMutationContext, options?: TurnRecoveryOptions): Promise<TurnRecoveryReport>;
  /** Read-only visibility view: transcript turns whose task event phase is committed. */
  committedTurns(): Promise<readonly CommittedTurnView[]>;
}

/**
 * Write boundaries of recovery, in durability order. Durable writes land
 * first (backfill event, checkpoint-failed status, task head); the
 * destructive transcript quarantine executes LAST so a crash before it can
 * never lose the ability to re-classify the turn on the next run.
 */
export type TurnRecoveryBoundary = "backfill" | "failedStatus" | "taskHead" | "quarantine";

export interface TurnRecoveryOptions {
  /**
   * Invoked before each recovery boundary's write; throwing simulates a crash
   * AT that boundary (fault injection) and doubles as an observability hook.
   * The backfill/failedStatus hooks fire when the write is decided (before the
   * event append); taskHead and quarantine fire immediately before their
   * physical writes.
   */
  beforeWrite?: (boundary: TurnRecoveryBoundary) => void | Promise<void>;
}
