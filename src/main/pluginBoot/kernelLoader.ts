// Kernel dynamic loading (single-instance strategy): the plugin kernel is
// imported at runtime from the prebuilt staging tree — never statically from
// vendor/kernel — so the whole host shares ONE kernel module instance (the
// import cache below keeps it a singleton even across loadKernel calls).
// type-only imports from the kernel package stay allowed everywhere.
import { pathToFileURL } from "node:url";
import type * as KernelModule from "@innocencecode/kernel";

/** The kernel surface boot needs (the staged dist's module namespace). */
export type Kernel = typeof KernelModule;

/** Cache of the in-flight/finished dynamic import: one kernel instance per process. */
let kernelPromise: Promise<Kernel> | undefined;

/** Forget the memoized import (test seam; a disposed boot should not be reused). */
export function resetKernelCache(): void {
  kernelPromise = undefined;
}

/**
 * Dynamically import the staging kernel entry and memoize it.
 *
 * `kernelPath` is the absolute path of `@innocencecode/kernel/dist/index.js`
 * under the staging node_modules tree (dev: the repo's build/dist; packaged:
 * resources/node_modules) — the caller (harnessGlue) resolves dev vs prod.
 * Successful imports (including with a different path, e.g. after a
 * re-package) intentionally return the first module: identity must stay
 * unique. FAILED imports are NOT memoized — Node does not cache failed
 * dynamic imports, so a retried boot re-attempts the load instead of being
 * poisoned forever by the first rejection (retry seam: ensureBoot).
 */
export function loadKernel(kernelPath: string): Promise<Kernel> {
  if (!kernelPromise) {
    const attempt = import(pathToFileURL(kernelPath).href).then(
      (module: unknown) => module as Kernel,
      (error: unknown) => {
        // Only forget OUR attempt: a concurrent success (or a test reset)
        // may have already replaced the memo — never clobber it.
        if (kernelPromise === attempt) kernelPromise = undefined;
        throw error;
      },
    );
    kernelPromise = attempt;
  }
  return kernelPromise;
}
