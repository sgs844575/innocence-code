/** full = 完全访问：连项目 deny 规则也跳过，一切自动放行（对应 UI 的橙色盾牌档）。 */
export type PermissionMode = "auto" | "ask" | "plan" | "full";

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
