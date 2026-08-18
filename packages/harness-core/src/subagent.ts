// Subagent spawning primitive. The kernel owns session construction, so it
// provides the spawner; plugin-subagent's Task tool is a thin consumer.

export interface SubagentOptions {
  systemPrompt: string;
  /** Tool names the child may use; "readOnly" = every readOnly tool; "all" = everything (Task itself is always excluded). */
  tools: string[] | "readOnly" | "all";
  /** Maximum loop turns for the child (default 20). */
  maxTurns?: number;
  prompt: string;
  signal?: AbortSignal;
}

export interface SubagentResult {
  finalText: string;
  turns: number;
}

export interface SubagentSpawner {
  run(options: SubagentOptions): Promise<SubagentResult>;
}
