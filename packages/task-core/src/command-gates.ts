/**
 * Completion gate computation of the TaskCommandService (split out of
 * command-service.ts): running tools, unresolved attribution conflicts,
 * unstable (prepared) turns, unreviewed changes and validation — including
 * the confirmValidationFailure override. Runs UNDER the mutation lease so a
 * concurrent review/resolve cannot slip between the read and the decision.
 */
import type { TaskEvent } from "./events";
import { validationOverrideEvent } from "./events";
import type { TaskState } from "./reducer";
import type { Route } from "./model";
import type { TaskCommandDeps } from "./command-types";
import type { CompletionGateDto } from "./command-types";
import { TaskCommandError } from "./command-ports";
import { appendDurable, statusedHunks } from "./command-shared";
import type { TaskIdClock } from "./ports";

export interface CompletionGateOutcome {
  gate: CompletionGateDto;
  /** True when the gate blocks completion. */
  blocks: boolean;
}

/**
 * Computes the completion gate over the leased state. When
 * `confirmValidationFailure` overrides a failed validation the
 * validationOverride event is appended durably and the gate's validation
 * entry is cleared BEFORE the block decision is made.
 */
export async function evaluateCompletionGate(input: {
  deps: TaskCommandDeps;
  clock: TaskIdClock;
  taskId: string;
  state: TaskState;
  events: readonly TaskEvent[];
  route: Route;
  confirmValidationFailure: boolean;
}): Promise<CompletionGateOutcome> {
  const { deps, clock, taskId, state, events, route, confirmValidationFailure } = input;
  const hunks = await statusedHunks(deps, taskId, state, route, events);
  const validation = deps.validator
    ? await deps.validator(taskId, state.activeRouteId, route.workspaceRoot)
    : { success: true };
  const gate: CompletionGateDto = {
    runningTools: 0, // P1: single-turn, no live tool index in the service
    unresolvedConflicts: deps.attribution.decisions(events)
      .filter((decision) => decision.status === "conflict").length,
    unstableCalls: [...state.turns.values()].filter((turn) => turn.phase === "prepared").length,
    unreviewedChanges: hunks.filter((hunk) => hunk.status !== "accepted" && hunk.status !== "restored").length,
    validation,
  };
  if (confirmValidationFailure && validation !== null && !validation.success) {
    gate.validation = null;
    await appendDurable(deps, taskId, [
      validationOverrideEvent({ validationResult: validation, clock }),
    ]);
  }
  const blocks = gate.unresolvedConflicts > 0 || gate.unstableCalls > 0 ||
    gate.unreviewedChanges > 0 || (gate.validation !== null && !gate.validation.success);
  return { gate, blocks };
}

/** Throws the structured completion-gate error when the gate blocks. */
export function throwIfBlocked(outcome: CompletionGateOutcome): void {
  if (outcome.blocks) {
    throw new TaskCommandError("completion-gate", "completion gate", { gate: outcome.gate });
  }
}
