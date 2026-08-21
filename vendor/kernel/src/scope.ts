import { Context } from "./context";
import type { Fiber } from "./fiber";

/**
 * Handle for one scope created by {@link createScope}.
 *
 * `ctx` is a derived context with its own service table and its own fiber;
 * `dispose` unwinds that fiber, releasing everything loaded on the scope,
 * without affecting the parent context or sibling scopes.
 */
export interface ScopeHandle {
  readonly ctx: Context;
  dispose(): Promise<void>;
}

/**
 * Create one independently disposable scope below `parent` (or below a fresh
 * root when omitted).
 *
 * A bare `derive()` keeps the parent's fiber, so contexts derived from it
 * share the parent's lifecycle. A scope instead owns a fiber: plugins,
 * effects and listeners registered on `scope.ctx` unwind together when the
 * handle is disposed, while the parent and sibling scopes keep running — and
 * unwinding the parent root cascades into every live scope below it.
 *
 * Implementation: the scope fiber is an empty carrier plugin started below
 * the parent, so registry bookkeeping, parent-record linkage and uid
 * allocation all come from the standard plugin path; the scope context then
 * derives from the carrier's context without a fiber argument, giving it its
 * own service table while inheriting the scope fiber.
 */
export function createScope(parent?: Context): ScopeHandle {
  const base = parent ?? new Context();
  const carrier = base.plugin({
    name: "scope",
    apply() {
      // The carrier entry is empty: the fiber exists for lifecycle ownership,
      // not to run plugin code. It settles ACTIVE on a later microtask.
    },
  });
  const fiber = carrier as Fiber;
  const ctx = carrier.ctx.derive();
  return {
    ctx,
    dispose: () => fiber.dispose(),
  };
}
