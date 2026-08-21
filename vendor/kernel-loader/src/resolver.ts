import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ModuleResolver } from "./index";

/** Options accepted by {@link createFileModuleResolver}. */
export interface FileModuleResolverOptions {
  /** Search roots in descending priority order; a user root first shadows later built-in roots. */
  roots: Array<string | URL>;
}

/**
 * Module resolver that loads plugins from directory roots.
 *
 * A specifier addresses a directory `<root>/<specifier>` whose entry point
 * is `dist/index.js`. Roots are probed in order and the first hit wins, so a
 * user root placed before a built-in root shadows same-named built-ins.
 * Implements the loader's {@link ModuleResolver} contract for `loader.internal`.
 */
export interface FileModuleResolver extends ModuleResolver {
  /** Dialect marker of this resolver implementation. */
  version: "v2";
}

/** Entry-point layout of a plugin directory below a root. */
const entryPoint = ["dist", "index.js"] as const;

/**
 * Create a file-based module resolver.
 *
 * @throws when `roots` is empty — a resolver without search roots is a
 * configuration error.
 */
export function createFileModuleResolver(options: FileModuleResolverOptions): FileModuleResolver {
  const roots = normalizeRoots(options.roots);
  const cache = new Map<string, Promise<unknown>>();
  return {
    version: "v2",
    import(specifier: string): Promise<unknown> {
      const cached = cache.get(specifier);
      if (cached) return cached;
      // Cache the in-flight load itself so concurrent imports of one
      // specifier share it, keeping module instances singletons.
      const load = locate(roots, specifier).then((file) => import(pathToFileURL(file).href));
      cache.set(specifier, load);
      // Only successful loads stay cached; failed lookups are retried on
      // the next import instead of failing permanently.
      load.catch(() => cache.delete(specifier));
      return load;
    },
  };
}

/** Normalize root inputs to absolute directory paths. */
function normalizeRoots(roots: ReadonlyArray<string | URL>): string[] {
  if (roots.length === 0) {
    throw new Error("file module resolver requires at least one root");
  }
  return roots.map((root) => (typeof root === "string" ? resolve(root) : fileURLToPath(root)));
}

/** Probe the roots in order for the specifier's entry-point file. */
async function locate(roots: ReadonlyArray<string>, specifier: string): Promise<string> {
  for (const root of roots) {
    const file = join(root, specifier, ...entryPoint);
    if (await isRegularFile(file)) return file;
  }
  throw new Error(`plugin not found: ${specifier} (searched ${roots.length} roots)`);
}

/** Whether the path exists and names a regular file. */
async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
