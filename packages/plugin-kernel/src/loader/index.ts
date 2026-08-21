import type { Context } from "../context";
import type { Fiber } from "../fiber";
import type { ObjectPlugin, Plugin } from "../registry";
import type { EntryCreateOptions, LoaderEntry } from "./tree";
import { LoaderTree } from "./tree";

/**
 * Injectable module resolver behind `loader.internal`.
 *
 * Hosts that own a module runtime publish it here; the loader fails loudly
 * when no resolver is configured, instead of silently skipping entries.
 */
export interface ModuleResolver {
  /** Dialect marker of the providing runtime; informational. */
  version: string;
  /** Import `specifier`; rejects when the module is unavailable. */
  import(specifier: string): Promise<unknown>;
}

/** Builtin names are addressed through this prefix in entry options. */
const builtinPrefix = "kernel:";

declare module "@innocencecode/plugin-kernel" {
  interface Context {
    /**
     * Config-tree loader service. Typed as always present; the accessor
     * exists at runtime only while the Loader plugin is loaded.
     */
    loader: LoaderService;
    /**
     * Config entry that started the current fiber's plugin, set by the
     * loader for every entry it mounts. Carriers (the include builtin)
     * read their config from it.
     */
    entry?: LoaderEntry;
  }
}

/**
 * Config-tree loader: owns the root {@link LoaderTree}, resolves builtin and
 * module specifiers, and mounts configured plugins as tree fibers.
 */
export class LoaderService {
  /** Builtin plugin registry; keys are names without the builtin prefix. */
  readonly builtins: Record<string, Plugin> = Object.create(null);
  /** Injectable module resolver; entries with bare specifiers need it. */
  internal?: ModuleResolver;
  readonly tree: LoaderTree;

  constructor(readonly ctx: Context) {
    this.tree = new LoaderTree(ctx);
  }

  /**
   * Create an entry and start it: import the plugin, mount it below the
   * tree's context, and wait for the plugin to settle.
   *
   * @param options - entry row; the id is generated when omitted.
   * @param parent - entry whose subtree receives the row (config carriers);
   * defaults to the loader's own tree.
   * @returns the created entry.
   * @throws when importing or starting the plugin fails.
   */
  async create(options: EntryCreateOptions, parent?: LoaderEntry): Promise<LoaderEntry> {
    const entry = this.add(options, parent);
    await this.startEntry(entry);
    return entry;
  }

  /** Add an entry to the tree without starting it. */
  add(options: EntryCreateOptions, parent?: LoaderEntry): LoaderEntry {
    const tree = parent ? this.subtreeOf(parent) : this.tree;
    return tree.add(options);
  }

  /** Iterate every entry of the tree, including mounted subtrees. */
  entries(): Generator<LoaderEntry, void, void> {
    return this.tree.entries();
  }

  /** Resolve an entry by composite id (see {@link LoaderTree.resolve}). */
  resolve(id: string): LoaderEntry {
    return this.tree.resolve(id);
  }

  /**
   * Wait for the whole tree to settle: passes over the tree keep awaiting
   * fibers that appeared during earlier passes — entries mounted by carriers
   * or by running plugins — until a full pass observes nothing new.
   *
   * @throws the single fiber failure, or an aggregate when several failed.
   */
  async await(): Promise<void> {
    const failures: unknown[] = [];
    const awaited = new Set<Fiber>();
    for (;;) {
      let progressed = false;
      for (const entry of this.tree.entries()) {
        if (!entry.fiber || awaited.has(entry.fiber)) continue;
        progressed = true;
        awaited.add(entry.fiber);
        try {
          await entry.fiber.await();
        } catch (reason) {
          failures.push(reason);
        }
      }
      if (!progressed) break;
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "loader fibers failed");
  }

  /** The subtree mounted on `parent`, created on first use below its fiber. */
  private subtreeOf(parent: LoaderEntry): LoaderTree {
    if (!parent.fiber) throw new Error(`cannot mount below entry ${parent.options.id}: not running`);
    parent.subtree ??= new LoaderTree(parent.fiber.ctx, parent);
    return parent.subtree;
  }

  /**
   * Import and mount one entry's plugin.
   *
   * Disabled entries are neither imported nor mounted. Import and startup
   * failures are wrapped with the entry's identity and rethrown, so they
   * surface through `create()` and `await()`.
   */
  private async startEntry(entry: LoaderEntry): Promise<void> {
    if (entry.options.disabled || entry.fiber) return;
    const { id, name } = entry.options;
    if (typeof name !== "string") {
      throw new Error(`loader entry ${id} has no valid import name`);
    }
    let plugin: Plugin;
    try {
      plugin = await this.importPlugin(name);
    } catch (reason) {
      throw new Error(`failed to import loader entry ${id} (${name}): ${messageOf(reason)}`, { cause: reason });
    }
    try {
      const started = entry.tree.ctx.plugin(plugin);
      // The carrier context must carry its entry before the plugin entry
      // runs; fiber loads always start on a later microtask.
      started.ctx.entry = entry;
      entry.fiber = started;
      await started;
    } catch (reason) {
      throw new Error(`failed to start loader entry ${id} (${name}): ${messageOf(reason)}`, { cause: reason });
    }
  }

  /**
   * Resolve a plugin by specifier.
   *
   * @throws for unknown builtins, and for bare specifiers when no module
   * resolver is configured.
   */
  async importPlugin(name: string): Promise<Plugin> {
    if (name.startsWith(builtinPrefix)) {
      const builtin = this.builtins[name.slice(builtinPrefix.length)];
      if (!builtin) throw new Error(`unknown loader builtin: ${name}`);
      return builtin;
    }
    if (!this.internal) {
      throw new Error(`cannot import "${name}": no module resolver configured (loader.internal)`);
    }
    return asPlugin(unwrapExports(await this.internal.import(name)), name);
  }
}

/**
 * Loader kernel plugin: publishes one {@link LoaderService} as the tree-wide
 * `ctx.loader` service and withdraws it again on unload.
 */
export const Loader: ObjectPlugin = {
  name: "loader",
  apply(ctx: Context) {
    return ctx.provide("loader", new LoaderService(ctx));
  },
};

/** Peel one `default` level off a module namespace, as bundlers produce it. */
function unwrapExports(exports: unknown): unknown {
  if (exports && typeof exports === "object" && "default" in exports) {
    return (exports as { default: unknown }).default;
  }
  return exports;
}

/** Require an imported value to carry a plugin shape. */
function asPlugin(value: unknown, name: string): Plugin {
  const valid = typeof value === "function"
    || (typeof value === "object" && value !== null && typeof (value as ObjectPlugin).apply === "function");
  if (!valid) {
    throw new TypeError(`module "${name}" did not export a plugin`);
  }
  return value as Plugin;
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export type { EntryCreateOptions, EntryOptions } from "./tree";
export { LoaderEntry, LoaderTree } from "./tree";
