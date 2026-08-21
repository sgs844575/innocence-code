import { createHash } from "node:crypto";
import type { ExecutionScope } from "./execution-scope";
import type { PermissionResource, ToolSideEffect } from "./policy";
import type { JsonSchema } from "./types";
import type { SubagentSpawner } from "./subagent";

export type { ToolSideEffect };

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
  /**
   * Read-only, per-invocation scope. The executor builds a fresh one (new
   * invocation id) for every tool call; it is never shared or reused.
   */
  readonly scope: ExecutionScope;
}

export interface Tool {
  name: string;
  description: string;
  /** True for tools with no side effects — plan mode auto-allows these. */
  readOnly: boolean;
  /** Coarse side-effect class for audit records and UI hints. */
  sideEffect?: ToolSideEffect;
  parameters: JsonSchema;

  /**
   * Executor chain (fixed order, fail-closed):
   *   raw args → validateArgs(raw) → permissionResource(raw) →
   *   validateResource(resource) → persistArgs(raw) once →
   *   persisted request / policy / mode / ask / audit → execute(raw).
   * Raw execution args exist only for the current invocation.
   */

  /** Cheap structural validation of RAW args; throws on bad input. */
  validateArgs?(args: Record<string, unknown>): void | Promise<void>;

  /**
   * Canonical, persistence-safe resource this call acts on. Built from raw
   * args, but `scope`/metadata must never contain raw secret-bearing values.
   */
  permissionResource(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): PermissionResource | Promise<PermissionResource>;

  /**
   * Persisted copy of the args: the ONLY shape that may enter history,
   * events, permission requests, audit and transcripts. Required for every
   * tool regardless of side effects (fail-closed SPI) — the registry rejects
   * registrations missing it.
   */
  persistArgs(args: Record<string, unknown>): Record<string, unknown>;

  /**
   * Runs the tool. Thrown/reported error messages flow into history and
   * audit UNREDACTED, so they must never embed raw argument values — report
   * the failing argument's NAME, not its content.
   */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Stable SHA-256 hex digest — the standard replacement for persisted content. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Command summary safe to persist: the program word only, and only when it
 * looks like a plain command name (≤16 chars of [A-Za-z0-9_.-], starting
 * with a letter). Anything else (long tokens, flags-with-values, secrets,
 * paths) collapses to a placeholder. The full command NEVER survives
 * redaction — pair with sha256Hex for change detection.
 */
export function redactCommand(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return isCommandWord(first) ? first : "[redacted]";
}

/**
 * Persisted command SUMMARY for Bash-like tools (what they store in
 * args.command for project-rule matching AND put in the resource scope, so
 * session grants carry the same granularity): the program word plus the
 * FOLLOWING subcommand tokens, each individually passing the same
 * command-word shape check. The walk stops at the first token that could
 * carry a value — flags, `=` assignments, quoted strings, paths, URLs, long
 * tokens — so argument values and secrets never survive. Capped at 8
 * tokens. Pair with sha256Hex for exact change detection of the raw command.
 */
export function redactCommandSummary(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const token of tokens) {
    if (kept.length >= 8 || !isCommandWord(token)) break;
    kept.push(token);
  }
  return kept.length > 0 ? kept.join(" ") : "[redacted]";
}

/** A command-shaped word: letter start, ≤16 chars of [A-Za-z0-9_.-], no spaces. */
function isCommandWord(token: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.\-]{0,15}$/.test(token);
}

/**
 * URL safe to persist: user-info, query and fragment are stripped; anything
 * unparseable collapses to a placeholder (fail closed).
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}
