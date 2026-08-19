import fs from "node:fs/promises";
import path from "node:path";
import { matchGlob } from "./glob";
import type { PermissionDecision, PolicyRule, ToolCallInfo } from "./policy";

/**
 * Project-level permission config (`.innocence/config.json`). Rule specs:
 *   "Read"                 — bare tool name: every call of that tool
 *   "Bash(npm test)"       — command tools: pattern tokens prefix-match the
 *                            tokens of the PERSISTED command summary (program
 *                            word + shape-checked subcommand tokens; flags and
 *                            argument values never persist); "*" matches any
 *                            single token
 *   "Edit(src/**)"         — path tools: workspace-relative glob on args.path
 *
 * Rules are matched against the tool's PERSISTED args (Tool.persistArgs), so
 * command specs match the redacted summary Bash keeps (`npm test -- -u`
 * persists as "npm test") and path specs keep working because paths stay in
 * the persisted copy verbatim.
 */
export interface ProjectPermissionConfig {
  allow?: string[];
  deny?: string[];
}

export function parseRuleSpec(spec: string, kind: "allow" | "deny"): PolicyRule {
  const trimmed = spec.trim();
  const paren = trimmed.indexOf("(");
  const toolName = (paren === -1 ? trimmed : trimmed.slice(0, paren)).trim();
  const param =
    paren === -1 ? undefined : trimmed.slice(paren + 1, trimmed.lastIndexOf(")"));
  if (!toolName) throw new Error(`invalid permission rule: ${spec}`);
  if (paren !== -1 && (param === undefined || !trimmed.endsWith(")"))) {
    throw new Error(`invalid permission rule: ${spec}`);
  }

  return {
    name: `${kind}:${trimmed}`,
    match(call: ToolCallInfo): PermissionDecision | "skip" {
      if (call.toolName !== toolName) return "skip";
      if (param === undefined) return kind;

      const command = typeof call.args.command === "string" ? call.args.command : undefined;
      const path = pickPath(call.args);
      if (command !== undefined) {
        const patternTokens = param.split(/\s+/).filter(Boolean);
        const cmdTokens = command.trim().split(/\s+/).filter(Boolean);
        // Pattern tokens are a prefix sequence; extra command tokens allowed.
        if (patternTokens.length > cmdTokens.length) return "skip";
        for (let i = 0; i < patternTokens.length; i++) {
          const p = patternTokens[i];
          const ok = p === "*" ? true : p === cmdTokens[i];
          if (!ok) return "skip";
        }
        return kind;
      }
      if (path !== undefined) {
        return matchGlob(param, path.replace(/\\/g, "/")) ? kind : "skip";
      }
      return "skip";
    },
  };
}

export function rulesFromConfig(config: ProjectPermissionConfig): PolicyRule[] {
  const rules: PolicyRule[] = [];
  // deny first: the engine evaluates deny rules before allow rules anyway,
  // but listing them first keeps rule order readable in debug output.
  for (const spec of config.deny ?? []) rules.push(parseRuleSpec(spec, "deny"));
  for (const spec of config.allow ?? []) rules.push(parseRuleSpec(spec, "allow"));
  return rules;
}

function pickPath(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file_path", "filePath", "absolute_path"]) {
    const v = args[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** MCP server entry in .innocence/config.json. */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Full .innocence/config.json shape. */
export interface InnocenceConfig {
  permissions?: ProjectPermissionConfig;
  mcpServers?: Record<string, McpServerConfig>;
}

/** Loads <root>/.innocence/config.json; missing/corrupt file -> empty config. */
export async function loadInnocenceConfig(root: string): Promise<InnocenceConfig> {
  try {
    const raw = await fs.readFile(
      path.join(root, ".innocence", "config.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as InnocenceConfig;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
