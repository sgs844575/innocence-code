import type { ExecutionScope } from "./execution-scope";
import type { ToolContext, ToolResult } from "./tool";

/**
 * Standardized terminal outcome of one tool invocation. The loop stamps it on
 * `toolResult` events so hosts can distinguish a tool failure from a timeout,
 * an ignored abort or a user stop.
 */
export type ToolOutcome = "success" | "error" | "aborted" | "timeout" | "unstable";

export const TOOL_TIMEOUT = "TOOL_TIMEOUT";
export const TOOL_UNSTABLE = "TOOL_UNSTABLE";
export type ToolExecutionErrorCode = typeof TOOL_TIMEOUT | typeof TOOL_UNSTABLE;

/** Rejects with `code` set, so callers can branch on the failure class. */
export class ToolExecutionError extends Error {
  readonly code: ToolExecutionErrorCode;

  constructor(code: ToolExecutionErrorCode, message: string) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
  }
}

/** How long the executor keeps waiting after the timeout abort before TOOL_UNSTABLE. */
export const DEFAULT_ABORT_GRACE_MS = 5_000;

/**
 * Persistence-safe view of the invocation that middleware layers receive.
 * `persistedArgs` is the tool's redacted copy — raw invocation args never
 * reach middleware. `scope` is the frozen per-invocation scope (own
 * invocationId plus the run identity inherited from the session).
 */
export interface ToolExecutionInvocation {
  readonly invocationId: string;
  readonly toolName: string;
  readonly persistedArgs: Record<string, unknown>;
  /** Derived signal: trips on parent abort OR on the timeout. */
  readonly signal: AbortSignal;
  readonly scope: ExecutionScope;
}

export interface ToolExecutionMiddleware {
  name: string;
  execute(
    invocation: ToolExecutionInvocation,
    next: () => Promise<ToolResult>,
  ): Promise<ToolResult>;
}

/** The tool body: derived signal plus the full scoped execution context. */
export type ToolBody = (signal: AbortSignal, ctx: ToolContext) => Promise<ToolResult>;

export interface ToolExecutionOptions {
  /** Hard deadline for the WHOLE middleware chain, middleware included. */
  timeoutMs: number;
  /** Extra wait after the timeout abort before declaring TOOL_UNSTABLE. */
  abortGraceMs?: number;
  execute: ToolBody;
}

/**
 * One prepared invocation handed to the executor. The context already carries
 * the fresh per-call scope (`ctx.scope.invocationId`); the executor derives a
 * dedicated AbortController per invocation and replaces `ctx.signal` with it.
 */
export interface ToolInvocation {
  readonly toolName: string;
  /** Persisted (redacted) args — the only shape middleware ever sees. */
  readonly persistedArgs: Record<string, unknown>;
  readonly ctx: ToolContext;
  /** Session/run signal; aborting it aborts this invocation with its reason. */
  readonly parentSignal?: AbortSignal;
}

/** Abort-shaped rejections (DOMException or Error named AbortError). */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "AbortError"
  );
}

/** Classification context: what the surrounding run looked like at failure time. */
export interface ToolOutcomeContext {
  /** True when the run/session signal had aborted when the failure was classified. */
  parentAborted?: boolean;
}

/**
 * Standardized outcome for an invocation that rejected. Classification never
 * depends on the abort reason's shape: when the parent run is aborted, any
 * non-timeout failure counts as "aborted" rather than "error".
 */
export function toolErrorOutcome(
  err: unknown,
  context: ToolOutcomeContext = {},
): Exclude<ToolOutcome, "success"> {
  if (err instanceof ToolExecutionError) {
    return err.code === TOOL_TIMEOUT ? "timeout" : "unstable";
  }
  if (isAbortError(err)) return "aborted";
  if (context.parentAborted) return "aborted";
  return "error";
}

function timeoutMessage(timeoutMs: number): string {
  return `工具执行超时（>${Math.round(timeoutMs / 1000)}s）`;
}

function unstableMessage(graceMs: number): string {
  return `工具被中止后 ${graceMs}ms 内未退出（TOOL_UNSTABLE）`;
}

/**
 * Runs one tool invocation:
 *
 * 1. Derives a per-invocation AbortController from the parent signal — the
 *    parent abort reason propagates to the tool unchanged.
 * 2. Composes the middleware chain around the tool body (first registered =
 *    outermost layer; later registrations sit closer to the tool).
 * 3. On timeout, ABORTS the tool first (`abort(new ToolExecutionError(
 *    TOOL_TIMEOUT))`), then waits for the chain to settle before reporting the
 *    timeout — the old Promise.race never actually stopped anything.
 * 4. WHATEVER aborted the derived signal (deadline or parent stop), arms the
 *    separate `abortGraceMs` window: if the chain still has not exited when
 *    it elapses, rejects with TOOL_UNSTABLE instead of hanging the loop for
 *    the rest of the timeout.
 */
export function executeToolInvocation(
  invocation: ToolInvocation,
  middleware: readonly ToolExecutionMiddleware[],
  options: ToolExecutionOptions,
): Promise<ToolResult> {
  const controller = new AbortController();
  const parent = invocation.parentSignal;
  const propagateParentAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", propagateParentAbort, { once: true });
  }

  const view: ToolExecutionInvocation = {
    invocationId: invocation.ctx.scope.invocationId,
    toolName: invocation.toolName,
    persistedArgs: invocation.persistedArgs,
    signal: controller.signal,
    scope: invocation.ctx.scope,
  };
  const ctx: ToolContext = { ...invocation.ctx, signal: controller.signal };

  const runChain = (): Promise<ToolResult> => {
    let next: () => Promise<ToolResult> = () => options.execute(controller.signal, ctx);
    for (let i = middleware.length - 1; i >= 0; i -= 1) {
      const layer = middleware[i];
      const inner = next;
      next = () => layer.execute(view, inner);
    }
    return next();
  };

  const graceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;

  return new Promise<ToolResult>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutError: ToolExecutionError | undefined;

    const cleanup = () => {
      if (deadline) clearTimeout(deadline);
      if (graceTimer) clearTimeout(graceTimer);
      parent?.removeEventListener("abort", propagateParentAbort);
      controller.signal.removeEventListener("abort", onDerivedAbort);
    };
    const settle = (ok: boolean, value: ToolResult | unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (ok) resolve(value as ToolResult);
      else reject(value);
    };
    const armGraceWindow = () => {
      if (settled || graceTimer !== undefined) return;
      graceTimer = setTimeout(
        () => settle(false, new ToolExecutionError(TOOL_UNSTABLE, unstableMessage(graceMs))),
        graceMs,
      );
    };
    // Any abort of the derived signal — deadline or parent stop — starts the
    // grace countdown for a chain that refuses to exit.
    const onDerivedAbort = () => armGraceWindow();
    controller.signal.addEventListener("abort", onDerivedAbort, { once: true });
    if (controller.signal.aborted) armGraceWindow();

    deadline = setTimeout(() => {
      timeoutError = new ToolExecutionError(TOOL_TIMEOUT, timeoutMessage(options.timeoutMs));
      // True abort first (the listener above arms the grace window), then the
      // standardized timeout error once the chain settles.
      controller.abort(timeoutError);
    }, options.timeoutMs);

    // Plugin middleware may throw synchronously; route that through settle so
    // timers and the parent listener are cleaned up immediately.
    try {
      runChain().then(
        (result) => {
          if (timeoutError !== undefined) {
            // Settled only after the abort: report the timeout, not the stale result.
            settle(false, timeoutError);
          } else {
            settle(true, result);
          }
        },
        (err) => settle(false, timeoutError ?? err),
      );
    } catch (err) {
      settle(false, err);
    }
  });
}
