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
 * reach middleware.
 */
export interface ToolExecutionInvocation {
  readonly invocationId: string;
  readonly toolName: string;
  readonly persistedArgs: Record<string, unknown>;
  /** Derived signal: trips on parent abort OR on the timeout. */
  readonly signal: AbortSignal;
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

/** Standardized outcome for an invocation that rejected. */
export function toolErrorOutcome(err: unknown): Exclude<ToolOutcome, "success"> {
  if (err instanceof ToolExecutionError) {
    return err.code === TOOL_TIMEOUT ? "timeout" : "unstable";
  }
  return isAbortError(err) ? "aborted" : "error";
}

function timeoutMessage(timeoutMs: number): string {
  return `工具执行超时（>${Math.round(timeoutMs / 1000)}s）`;
}

function unstableMessage(graceMs: number): string {
  return `工具超时中止后 ${graceMs}ms 内未退出（TOOL_UNSTABLE）`;
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
 * 4. If the chain still has not exited after the separate `abortGraceMs`
 *    window, rejects with TOOL_UNSTABLE instead of hanging the loop.
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
    };
    const settle = (ok: boolean, value: ToolResult | unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (ok) resolve(value as ToolResult);
      else reject(value);
    };

    deadline = setTimeout(() => {
      timeoutError = new ToolExecutionError(TOOL_TIMEOUT, timeoutMessage(options.timeoutMs));
      controller.abort(timeoutError);
      // Deadline passed: give the chain the grace window to actually exit,
      // then declare the tool unstable instead of blocking the loop forever.
      graceTimer = setTimeout(
        () => settle(false, new ToolExecutionError(TOOL_UNSTABLE, unstableMessage(graceMs))),
        graceMs,
      );
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
