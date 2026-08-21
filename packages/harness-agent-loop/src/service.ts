import type { SubagentSpawner } from "@innocencecode/harness-agent";
import type { PermissionEngine } from "@innocencecode/harness-permissions";
import type { Provider } from "@innocencecode/harness-providers";
import type {
  ContextManager,
  HarnessEventListener,
  Message,
} from "@innocencecode/harness-session";
import type { ExecutionScopeIdentity, ToolsService } from "@innocencecode/harness-tools";
import type { Context } from "@innocencecode/kernel";
import { runLoop, type LoopResult } from "./loop";

// Services are typed on `Context` through declaration merging by their
// publisher (kernel ServiceTable contract). The member is live only while the
// loop plugin fiber publishing it is active; before load and after its unwind
// the property is absent at runtime.
declare module "@innocencecode/kernel" {
  interface Context {
    loop: RunLoopFunction;
  }
}

/** Session-level wiring the loop consumes: spine services and defaults. */
export interface LoopDeps {
  /** Tools spine service consumed instead of the plugin registry. */
  tools: ToolsService;
  /** Permission engine gating every tool call (permissions spine engine). */
  permission: PermissionEngine;
  /** Provider streaming model turns (providers spine). */
  provider: Provider;
  /** Session ledger; the loop owns every push (session spine history). */
  history: Message[];
  /** System prompt for each provider turn; a function is resolved once per run. */
  systemPrompt: string | (() => string);
  workspaceRoot: string;
  /** Listener receiving every HarnessEvent of every run. */
  onEvent: HarnessEventListener;
  /** Session-owned compaction manager (session spine compactor). */
  compactor?: ContextManager;
  /** Spawner bound to each invocation scope with the parent identity (agent spine). */
  spawner?: SubagentSpawner;
  maxTurns?: number;
  toolTimeoutMs?: number;
  abortGraceMs?: number;
}

/** Per-run options; each member overrides the {@link LoopDeps} default. */
export interface LoopRunOptions {
  signal?: AbortSignal;
  /**
   * Run-level identity inherited by every per-invocation scope minted in this
   * run (sessionId/routeId/taskId/parentInvocationId). Subagent children run
   * with the parent's identity plus the spawning invocation's id.
   */
  scope?: ExecutionScopeIdentity;
  maxTurns?: number;
  toolTimeoutMs?: number;
  abortGraceMs?: number;
}

/** Bound loop entry: one canonical user message in, one LoopResult out. */
export type RunLoopFunction = (input: Message, opts?: LoopRunOptions) => Promise<LoopResult>;

/**
 * Binds the session-level dependencies into a replaceable loop function. The
 * returned function keeps the original runLoop semantics stage for stage: the
 * canonical input (already skill-expanded and processor-run by the session)
 * enters the loop, tool-result user turns pushed by the loop itself never
 * pass through processors.
 */
export function createRunLoop(deps: LoopDeps): RunLoopFunction {
  return (input, opts = {}) =>
    runLoop(deps.history, input, {
      tools: deps.tools,
      permission: deps.permission,
      provider: deps.provider,
      systemPrompt: typeof deps.systemPrompt === "function" ? deps.systemPrompt() : deps.systemPrompt,
      workspaceRoot: deps.workspaceRoot,
      onEvent: deps.onEvent,
      compactor: deps.compactor,
      signal: opts.signal,
      maxTurns: opts.maxTurns ?? deps.maxTurns,
      toolTimeoutMs: opts.toolTimeoutMs ?? deps.toolTimeoutMs,
      abortGraceMs: opts.abortGraceMs ?? deps.abortGraceMs,
      spawner: deps.spawner,
      scope: opts.scope,
    });
}

/** Shape of the loop spine plugin (kernel Plugin contract). */
export interface AgentLoopPlugin {
  readonly name: "harness-agent-loop";
  apply(ctx: Context): () => void;
}

/**
 * Wraps a {@link RunLoopFunction} as the loop spine plugin (boot mounting):
 * `apply` publishes it under "loop" on the scope owning the plugin context
 * and returns the withdraw handle, so the run function disappears when the
 * plugin fiber unwinds.
 */
export function createAgentLoopPlugin(deps: LoopDeps): AgentLoopPlugin {
  const run = createRunLoop(deps);
  return {
    name: "harness-agent-loop",
    apply: (ctx) => ctx.provide("loop", run),
  };
}
