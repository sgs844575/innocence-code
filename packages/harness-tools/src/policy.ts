/**
 * Canonical resource a tool wants to act on. `action`/`kind` are free-form
 * lowercase words (write/path, execute/command, call/mcp, spawn/agent,
 * navigate/url, read/path …); `scope` is the canonical, persistence-safe
 * identifier of the exact resource (workspace-relative path, program word,
 * server/tool pair, agent type, redacted URL …).
 *
 * IMPORTANT: everything in a PermissionResource is persisted (history,
 * events, permission asks, audit, transcripts). Builders must redact — the
 * raw values an invocation carries must never end up in `scope`.
 */
export interface PermissionResource {
  action: string;
  kind: string;
  scope: string;
}

/**
 * Coarse side-effect class of a tool, for audit records and UI hints.
 * "delegated": the effects happen inside a child agent session that audits
 * them itself — the parent must not double-count them (P1 plugin-task).
 */
export type ToolSideEffect =
  | "none"
  | "paths"
  | "process"
  | "network"
  | "delegated"
  | "unknown";

/** What the permission engine is asked about (rules match persisted args). */
export interface ToolCallInfo {
  toolName: string;
  args: Record<string, unknown>;
}
