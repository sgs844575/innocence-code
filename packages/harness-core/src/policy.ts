export type PermissionMode = "auto" | "ask" | "plan";

export type PermissionDecision = "allow" | "deny" | "ask";
/** "skip" = this rule has no opinion. */
export type RuleVote = PermissionDecision | "skip";

export type AskResponse = "allow" | "allowSession" | "deny";

/** What the permission engine is asked about. */
export interface ToolCallInfo {
  toolName: string;
  args: Record<string, unknown>;
}

export interface PolicyRule {
  name: string;
  match(call: ToolCallInfo): RuleVote;
}
