// Shim: Tool face and redaction helpers live in the tools spine;
// ToolSideEffect in the permissions spine (single source after T6).
export type { Tool, ToolContext, ToolResult } from "@innocencecode/harness-tools";
export type { ToolSideEffect } from "@innocencecode/harness-permissions";
export {
  redactCommand,
  redactCommandSummary,
  redactUrl,
  sha256Hex,
} from "@innocencecode/harness-tools";
