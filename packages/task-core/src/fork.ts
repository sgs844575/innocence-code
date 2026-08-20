import type { TaskState } from "./reducer";

export interface ForkRequest {
  parentRouteId: string;
  sourceTurnId: string;
  checkpointId: string;
  prompt: string;
}

export interface ForkUserMessageInput {
  routeId: string;
  turnId: string;
  editedText: string;
}

export interface RetryAssistantTurnInput {
  routeId: string;
  turnId: string;
}

function sourceTurn(
  state: TaskState,
  routeId: string,
  turnId: string,
  role: "user" | "assistant",
) {
  if (state.workspaceKind !== "git") {
    throw new Error("Git repository required for code-state fork");
  }
  if (!state.routes.has(routeId)) throw new Error(`route not found: ${routeId}`);
  const turn = state.turns.get(turnId);
  if (!turn || turn.routeId !== routeId || turn.phase !== "committed") {
    throw new Error(`committed turn not found: ${turnId}`);
  }
  if (turn.role !== role) throw new Error(`${role} turn required: ${turnId}`);
  if (!turn.parentCheckpointId) {
    throw new Error(`parent checkpoint not found for turn: ${turnId}`);
  }
  return turn;
}

export function forkFromUserMessage(
  state: TaskState,
  input: ForkUserMessageInput,
): ForkRequest {
  const turn = sourceTurn(state, input.routeId, input.turnId, "user");
  if (!input.editedText.trim()) throw new Error("edited prompt is required");
  return {
    parentRouteId: input.routeId,
    sourceTurnId: input.turnId,
    checkpointId: turn.parentCheckpointId!,
    prompt: input.editedText,
  };
}

export function retryAssistantTurn(
  state: TaskState,
  input: RetryAssistantTurnInput,
): ForkRequest {
  const turn = sourceTurn(state, input.routeId, input.turnId, "assistant");
  if (!turn.prompt) {
    throw new Error(`original user prompt not found for turn: ${input.turnId}`);
  }
  return {
    parentRouteId: input.routeId,
    sourceTurnId: input.turnId,
    checkpointId: turn.parentCheckpointId!,
    prompt: turn.prompt,
  };
}
