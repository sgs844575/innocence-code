import type { JsonSchema } from "./types";
import type { SubagentSpawner } from "./subagent";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolContext {
  /** All file-ish tools must confine themselves to this directory. */
  workspaceRoot: string;
  /** Aborted when the user stops the run; long operations should check it. */
  signal: AbortSignal;
  log(level: "info" | "warn" | "error", msg: string, data?: unknown): void;
  /** Provided by the kernel; absent in hosts that don't support subagents. */
  subagent?: SubagentSpawner;
}

export interface Tool {
  name: string;
  description: string;
  /** True for tools with no side effects — plan mode auto-allows these. */
  readOnly: boolean;
  parameters: JsonSchema;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
