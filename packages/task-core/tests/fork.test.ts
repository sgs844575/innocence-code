import { describe, expect, it } from "vitest";
import {
  forkFromUserMessage,
  retryAssistantTurn,
  type TaskState,
} from "../src/index";

function state(workspaceKind: "git" | "snapshot" = "git"): TaskState {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    sessionId: "session-1",
    workspaceRoot: "D:/repo",
    workspaceKind,
    mode: "isolated",
    activeRouteId: "main",
    status: "ready",
    lastCommittedEventId: null,
    routes: new Map([
      [
        "main",
        {
          routeId: "main",
          parentRouteId: null,
          forkTurnId: null,
          checkpointId: "c2",
          workspaceRoot: "D:/repo",
          readonly: false,
        },
      ],
    ]),
    checkpoints: new Map(),
    turns: new Map([
      [
        "u2",
        {
          turnId: "u2",
          checkpointId: "c1",
          routeId: "main",
          phase: "committed",
          role: "user",
          prompt: "original prompt",
          parentCheckpointId: "c1",
        },
      ],
      [
        "a2",
        {
          turnId: "a2",
          checkpointId: "c2",
          routeId: "main",
          phase: "committed",
          role: "assistant",
          prompt: "original prompt",
          parentCheckpointId: "c1",
        },
      ],
    ]),
  };
}

describe("task route fork commands", () => {
  it("forks an edited user message from its parent checkpoint", () => {
    const request = forkFromUserMessage(state(), {
      routeId: "main",
      turnId: "u2",
      editedText: "revised",
    });
    expect(request).toMatchObject({
      parentRouteId: "main",
      sourceTurnId: "u2",
      checkpointId: "c1",
      prompt: "revised",
    });
  });

  it("retries an assistant turn with the original user prompt", () => {
    const request = retryAssistantTurn(state(), { routeId: "main", turnId: "a2" });
    expect(request).toMatchObject({
      parentRouteId: "main",
      sourceTurnId: "a2",
      checkpointId: "c1",
      prompt: "original prompt",
    });
  });

  it("rejects code-state forks for non-Git tasks", () => {
    expect(() =>
      forkFromUserMessage(state("snapshot"), {
        routeId: "main",
        turnId: "u2",
        editedText: "revised",
      }),
    ).toThrow("Git repository required");
  });
});
