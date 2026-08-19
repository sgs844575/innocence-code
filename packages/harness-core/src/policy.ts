/** full = 完全访问：连项目 deny 规则也跳过，一切自动放行（对应 UI 的橙色盾牌档）。 */
export type PermissionMode = "auto" | "ask" | "plan" | "full";

export type PermissionDecision = "allow" | "deny" | "ask";
/** "skip" = this rule has no opinion. */
export type RuleVote = PermissionDecision | "skip";

export type AskResponse = "allow" | "allowSession" | "deny";

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
 * What the permission engine resolves. `args` is the tool's persisted
 * (redacted) copy, never the raw execution args.
 */
export interface PermissionRequest {
  toolName: string;
  resource: PermissionResource;
  args: Record<string, unknown>;
}

/** Coarse side-effect class of a tool, for audit records and UI hints. */
export type ToolSideEffect = "none" | "paths" | "process" | "network" | "unknown";

/** What the permission engine is asked about (rules match persisted args). */
export interface ToolCallInfo {
  toolName: string;
  args: Record<string, unknown>;
}

export interface PolicyRule {
  name: string;
  match(call: ToolCallInfo): RuleVote;
}
