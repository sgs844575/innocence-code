/** Unwind support: batch disposer execution with error aggregation. */
import type { Context } from "./context";
import type { UnwindErrorPayload } from "./events";
import type { Disposer } from "./fiber";

/** Effect bookkeeping an unwind operates on (see `Fiber` for the full record). */
export interface UnwindableRecord {
  /** Cleanup to run at most once. */
  disposer?: Disposer;
  /** Set once the disposer has run, so it never runs twice. */
  executed?: boolean;
}

/** Input shape of {@link emitUnwindErrors}; `errors` may be any readonly list. */
export type UnwindErrorReport = Omit<UnwindErrorPayload, "errors"> & {
  errors: readonly unknown[];
};

/**
 * Execute every pending disposer in `records` in reverse registration order.
 *
 * A failing disposer never stops the batch: each failure is appended to
 * `errors` and the unwind moves on, so cleanup runs to completion and the
 * caller ends up with the full failure list.
 */
export async function unwindRecords(
  records: readonly UnwindableRecord[],
  errors: unknown[],
): Promise<void> {
  const dying = [...records].reverse();
  for (const record of dying) {
    if (record.executed) continue;
    record.executed = true;
    try {
      await record.disposer?.();
    } catch (reason) {
      errors.push(reason);
    }
  }
}

/**
 * Publish the aggregated cleanup failures of one finished unwind on the
 * context's event bus.
 *
 * The payload carries a defensive copy, so later mutation of the source
 * list cannot rewrite an already-delivered report.
 */
export function emitUnwindErrors(ctx: Context, report: UnwindErrorReport): void {
  ctx.emit("internal/unwind-error", { ...report, errors: [...report.errors] });
}
