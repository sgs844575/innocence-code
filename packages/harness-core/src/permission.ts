import type {
  AskResponse,
  PermissionMode,
  PolicyRule,
  ToolCallInfo,
} from "./policy";

export interface PermissionResolution {
  decision: "allow" | "deny";
  /** Which pipeline stage produced the decision (for events/debugging). */
  via: "denyRule" | "planMode" | "allowRule" | "autoMode" | "sessionGrant" | "ask";
  reason: string;
}

export interface PermissionDecider {
  ask(call: ToolCallInfo): Promise<AskResponse>;
}

export interface PermissionEngineOptions {
  mode: PermissionMode;
  decider: PermissionDecider;
  /** Used to normalize absolute paths in args to workspace-relative form. */
  workspaceRoot?: string;
}

/** Grant key: command tools key on the first word, others on the tool name. */
export function defaultGrantKey(call: ToolCallInfo): string {
  const command = call.args.command;
  if (typeof command === "string") {
    const first = command.trim().split(/\s+/)[0] ?? "";
    if (first) return `${call.toolName}(${first})`;
  }
  return call.toolName;
}

/**
 * Pipeline (short-circuit, deny-first for safety):
 *   1. any deny rule           -> DENY
 *   2. plan mode               -> readOnly ? ALLOW : DENY
 *   3. any allow rule          -> ALLOW
 *   4. auto mode               -> ALLOW
 *   5. session grant           -> ALLOW
 *   6. ask (via injected decider; "allowSession" also writes a grant)
 */
export class PermissionEngine {
  private rules: PolicyRule[] = [];
  private sessionGrants = new Set<string>();
  private mode: PermissionMode;
  private readonly decider: PermissionDecider;
  private readonly workspaceRoot?: string;

  constructor(opts: PermissionEngineOptions) {
    this.mode = opts.mode;
    this.decider = opts.decider;
    this.workspaceRoot = opts.workspaceRoot;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  addRules(rules: PolicyRule[]): void {
    this.rules.push(...rules);
  }

  clearRules(): void {
    this.rules = [];
  }

  grantSession(key: string): void {
    this.sessionGrants.add(key);
  }

  async resolve(
    call: ToolCallInfo,
    toolMeta: { readOnly: boolean },
  ): Promise<PermissionResolution> {
    const normalized = this.normalize(call);

    for (const rule of this.rules) {
      if (rule.match(normalized) === "deny") {
        return { decision: "deny", via: "denyRule", reason: `${rule.name} 命中拒绝规则` };
      }
    }

    if (this.mode === "plan" && !toolMeta.readOnly) {
      return {
        decision: "deny",
        via: "planMode",
        reason: "计划模式下只允许只读操作，请先给出计划再切换模式执行",
      };
    }

    for (const rule of this.rules) {
      if (rule.match(normalized) === "allow") {
        return { decision: "allow", via: "allowRule", reason: `${rule.name} 命中允许规则` };
      }
    }

    if (this.mode === "auto") {
      return { decision: "allow", via: "autoMode", reason: "自动模式" };
    }

    const key = defaultGrantKey(normalized);
    if (this.sessionGrants.has(key)) {
      return { decision: "allow", via: "sessionGrant", reason: `会话内已允许 ${key}` };
    }

    const answer = await this.decider.ask(normalized);
    if (answer === "allow") {
      return { decision: "allow", via: "ask", reason: "用户本次允许" };
    }
    if (answer === "allowSession") {
      this.sessionGrants.add(key);
      return { decision: "allow", via: "ask", reason: `用户允许（会话内 ${key}）` };
    }
    return { decision: "deny", via: "ask", reason: "用户拒绝" };
  }

  /** Absolute paths under workspaceRoot become workspace-relative for rule matching. */
  private normalize(call: ToolCallInfo): ToolCallInfo {
    if (!this.workspaceRoot) return call;
    const args = { ...call.args };
    for (const key of ["path", "file_path", "filePath", "absolute_path"]) {
      const v = args[key];
      if (typeof v !== "string") continue;
      let abs = v;
      if (!/^[a-zA-Z]:[\\/]/.test(v) && !v.startsWith("/") && !v.startsWith("\\")) {
        abs = `${this.workspaceRoot}/${v}`;
      }
      const norm = abs.replace(/\\/g, "/").toLowerCase();
      const root = this.workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
      if (norm === root) {
        args[key] = ".";
      } else if (norm.startsWith(`${root}/`)) {
        args[key] = norm.slice(root.length + 1);
      } else {
        // Outside the workspace: keep the absolute form; fs tools will reject
        // escapes themselves, and path rules simply won't match.
        args[key] = abs;
      }
    }
    return { ...call, args };
  }
}
