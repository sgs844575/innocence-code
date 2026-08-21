// Spine dynamic loading: the registration spine (logger, tools, permissions,
// providers, skills, system-prompt, agents, session, agent-loop) and the
// kernel loader are imported at runtime from the SAME staging node_modules
// tree as the kernel itself, so every consumer — the boot root, route session
// scopes and the disk-loaded capability plugins (whose own bare imports
// resolve through the same tree) — shares ONE set of spine module identities.
// The suite is memoized per process, mirroring kernelLoader's semantics.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  SessionSpineSuite,
} from "@innocencecode/harness-electron";
import type * as KernelLoaderModule from "@innocencecode/kernel-loader";
import { loadKernel, type Kernel } from "./kernelLoader";

/** The loader face the boot composition mounts (kernel-loader module). */
export type LoaderModule = typeof KernelLoaderModule;

/** One dynamically loaded kernel + spine suite (single module identities). */
export interface KernelSuite {
  readonly kernel: Kernel;
  readonly spine: SessionSpineSuite;
  readonly loader: LoaderModule;
}

/** Cache of the in-flight/finished suite import: one suite per process. */
let suitePromise: Promise<KernelSuite> | undefined;

/** Staged library entry under the staging node_modules/@innocencecode tree. */
function libEntry(kernelPath: string, name: string): string {
  // kernelPath = <root>/node_modules/@innocencecode/kernel/dist/index.js
  const scopeDir = path.resolve(path.dirname(kernelPath), "..", "..");
  return path.join(scopeDir, name, "dist", "index.js");
}

/** Import one staged module namespace (identity: the staging dist file). */
async function importLib(kernelPath: string, name: string): Promise<unknown> {
  return import(pathToFileURL(libEntry(kernelPath, name)).href);
}

/** Forget the memoized suite (test seam, paired with resetKernelCache). */
export function resetSuiteCache(): void {
  suitePromise = undefined;
}

/**
 * Dynamically import the kernel and the registration spine from the staging
 * tree and memoize the suite. Successful imports intentionally keep the
 * first module identities; FAILED attempts are not memoized (same retry
 * semantics as loadKernel). The kernel member shares loadKernel's cache, so
 * suite and kernel are the same module instance by construction.
 */
export function loadKernelSuite(kernelPath: string): Promise<KernelSuite> {
  if (!suitePromise) {
    const load = async (): Promise<KernelSuite> => {
      const [kernel, logger, tools, permissions, providers, skills, systemPrompt, agents, session, loop, loader] =
        await Promise.all([
          loadKernel(kernelPath),
          importLib(kernelPath, "kernel-logger"),
          importLib(kernelPath, "harness-tools"),
          importLib(kernelPath, "harness-permissions"),
          importLib(kernelPath, "harness-providers"),
          importLib(kernelPath, "harness-skills"),
          importLib(kernelPath, "harness-system-prompt"),
          importLib(kernelPath, "harness-agent"),
          importLib(kernelPath, "harness-session"),
          importLib(kernelPath, "harness-agent-loop"),
          importLib(kernelPath, "kernel-loader"),
        ]);
      return {
        kernel,
        spine: {
          logger,
          tools,
          permissions,
          providers,
          skills,
          systemPrompt,
          agents,
          session,
          loop,
        } as unknown as SessionSpineSuite,
        loader: loader as LoaderModule,
      };
    };
    // The memoized promise is the CHAINED one; the rejection handler compares
    // against it so only the memoized rejection is forgotten (a concurrent
    // success or a test reset is never clobbered).
    const memo: Promise<KernelSuite> = load().catch((error: unknown) => {
      if (suitePromise === memo) suitePromise = undefined;
      throw error;
    });
    suitePromise = memo;
  }
  return suitePromise;
}
