import type {
  AskResponse,
  PermissionMode,
  PermissionRequest,
  PermissionResource,
  PolicyRule,
  ToolCallInfo,
  ToolSideEffect,
} from "./policy";

export interface PermissionResolution {
  decision: "allow" | "deny";
  /** Which pipeline stage produced the decision (for events/debugging). */
  via:
    | "fullMode"
    | "denyRule"
    | "planMode"
    | "allowRule"
    | "autoMode"
    | "sessionGrant"
    | "ask"
    | "validateResource";
  reason: string;
}

export interface PermissionDecider {
  ask(request: PermissionRequest): Promise<AskResponse>;
}

/** Hard, host-injected resource validation (e.g. blocked URLs/dirs). Throwing rejects the call. */
export type ResourceValidator = (resource: PermissionResource) => void | Promise<void>;

/** One audit record per resolution — carries the persisted request only. */
export interface PermissionAuditEntry {
  mode: PermissionMode;
  request: PermissionRequest;
  resolution: PermissionResolution;
  tool: { readOnly: boolean; sideEffect: ToolSideEffect };
}

export type PermissionAuditor = (entry: PermissionAuditEntry) => void;

export interface PermissionEngineOptions {
  mode: PermissionMode;
  decider: PermissionDecider;
  /** Used to normalize absolute paths in args to workspace-relative form. */
  workspaceRoot?: string;
  /** Hard resource validation; runs in EVERY mode (full only skips asking). */
  validateResource?: ResourceValidator;
  /** Audit sink; invoked once per resolution with the persisted request. */
  audit?: PermissionAuditor;
}

/**
 * Grant key: tool name + canonical resource joined with NUL separators.
 * Session grants therefore never bleed across actions, kinds or scopes.
 */
export function resourceGrantKey(toolName: string, resource: PermissionResource): string {
  return `${toolName}\u0000${resource.action}\u0000${resource.kind}\u0000${resource.scope}`;
}

/**
 * Pipeline (short-circuit, deny-first for safety):
 *   0. validateResource      -> throw = reject（全模式硬校验，fail-closed）
 *   1. full mode             -> ALLOW（含 deny 规则，完全访问；仅跳过询问）
 *   2. any deny rule         -> DENY
 *   3. plan mode             -> readOnly ? ALLOW : DENY
 *   4. any allow rule        -> ALLOW
 *   5. auto mode             -> ALLOW
 *   6. session grant (resource key) -> ALLOW
 *   7. ask (via injected decider; "allowSession" also writes a grant)
 * Every resolution (including full mode) is audited with the persisted request.
 */
export class PermissionEngine {
  private rules: PolicyRule[] = [];
  private sessionGrants = new Set<string>();
  private mode: PermissionMode;
  private readonly decider: PermissionDecider;
  private readonly workspaceRoot?: string;
  private readonly validateResource?: ResourceValidator;
  private readonly audit?: PermissionAuditor;

  constructor(opts: PermissionEngineOptions) {
    this.mode = opts.mode;
    this.decider = opts.decider;
    this.workspaceRoot = opts.workspaceRoot;
    this.validateResource = opts.validateResource;
    this.audit = opts.audit;
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
    request: PermissionRequest,
    toolMeta: { readOnly: boolean; sideEffect?: ToolSideEffect },
  ): Promise<PermissionResolution> {
    // Hard validation first, in EVERY mode — full mode only skips asking.
    // A rejection is ALSO audited (decision deny, via validateResource) before
    // rethrowing, so the ledger records every gate decision, not just pipeline
    // stages that ran to completion.
    try {
      await this.validateResource?.(request.resource);
    } catch (err) {
      this.audit?.({
        mode: this.mode,
        request,
        resolution: {
          decision: "deny",
          via: "validateResource",
          reason: err instanceof Error ? err.message : String(err),
        },
        tool: { readOnly: toolMeta.readOnly, sideEffect: toolMeta.sideEffect ?? "unknown" },
      });
      throw err;
    }

    const resolution = await this.decide(request, toolMeta);
    this.audit?.({
      mode: this.mode,
      request,
      resolution,
      tool: { readOnly: toolMeta.readOnly, sideEffect: toolMeta.sideEffect ?? "unknown" },
    });
    return resolution;
  }

  private async decide(
    request: PermissionRequest,
    toolMeta: { readOnly: boolean },
  ): Promise<PermissionResolution> {
    const normalized = this.normalize({
      toolName: request.toolName,
      args: request.args,
    });

    // 完全访问：最顶层短路，连项目 deny 规则也放行（UI 明示慎用）。
    if (this.mode === "full") {
      return { decision: "allow", via: "fullMode", reason: "完全访问模式" };
    }

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

    const key = resourceGrantKey(request.toolName, request.resource);
    if (this.sessionGrants.has(key)) {
      return { decision: "allow", via: "sessionGrant", reason: `会话内已允许 ${key.split("\u0000")[3]}` };
    }

    const answer = await this.decider.ask(request);
    if (answer === "allow") {
      return { decision: "allow", via: "ask", reason: "用户本次允许" };
    }
    if (answer === "allowSession") {
      this.sessionGrants.add(key);
      return {
        decision: "allow",
        via: "ask",
        reason: `用户允许（会话内 ${key.split("\u0000")[3]}）`,
      };
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
