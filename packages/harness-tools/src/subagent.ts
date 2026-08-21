// Subagent spawning primitive. The kernel owns session construction, so it
// provides the spawner; plugin-subagent's Task tool is a thin consumer.

import type { ExecutionScope } from "./execution-scope";

export interface SubagentOptions {
  systemPrompt: string;
  /** Tool names the child may use; "readOnly" = every readOnly tool; "all" = everything (Task itself is always excluded). */
  tools: string[] | "readOnly" | "all";
  /** Maximum loop turns for the child (default 20). */
  maxTurns?: number;
  prompt: string;
  signal?: AbortSignal;
  /**
   * Kernel-injected identity of the invocation spawning this child (the loop
   * binds it via `bindSubagentSpawner`). The child session inherits
   * sessionId/taskId/routeId from it and stamps `parentInvocationId` with its
   * invocation id. Hosts calling a spawner directly may omit it.
   */
  parentScope?: ExecutionScope;
}

export interface SubagentResult {
  finalText: string;
  turns: number;
}

export interface SubagentSpawner {
  run(options: SubagentOptions): Promise<SubagentResult>;
}
