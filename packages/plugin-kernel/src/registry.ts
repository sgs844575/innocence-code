import type { Context } from "./context";
import { Fiber, toAwaitable } from "./fiber";
import type { PluginCallback, StartupResult } from "./fiber";

/** Plugin packaged as an object with an `apply` method. */
export interface ObjectPlugin {
  /** Display name used in fiber diagnostics. */
  name?: string;
  /** Plugin body; a returned function becomes its startup disposer. */
  apply(ctx: Context): StartupResult;
}

/** Plugin packaged as a bare function. */
export type FunctionPlugin = (ctx: Context) => StartupResult;

/** Every plugin shape accepted by `ctx.plugin()`. */
export type Plugin = ObjectPlugin | FunctionPlugin;

/** Registry record shared by all fibers of one plugin callback. */
export interface PluginRuntime {
  /** Display name copied from the plugin shape. */
  name?: string;
  /** The entry callback that identifies the plugin. */
  callback: PluginCallback;
  /** Live fibers of this plugin, including failed ones. */
  fibers: Fiber[];
}

/**
 * Runtime table of loaded plugins.
 *
 * A runtime stays listed while any of its fibers is alive — including
 * fibers whose startup failed — and is forgotten only once every fiber has
 * been disposed.
 */
export class Registry {
  private readonly runtimes = new Map<PluginCallback, PluginRuntime>();
  private lastUid = 0;

  /** Number of plugins with at least one live fiber. */
  get size(): number {
    return this.runtimes.size;
  }

  /** Whether the plugin has a runtime record. */
  has(plugin: Plugin): boolean {
    return this.runtimeOf(plugin) !== undefined;
  }

  /** The plugin's runtime record, if any. */
  get(plugin: Plugin): PluginRuntime | undefined {
    return this.runtimeOf(plugin);
  }

  /**
   * Dispose every fiber of the plugin and forget its runtime record.
   *
   * @returns the removed runtime, or `undefined` when none was registered.
   */
  delete(plugin: Plugin): PluginRuntime | undefined {
    const runtime = this.runtimeOf(plugin);
    if (!runtime) return undefined;
    for (const fiber of [...runtime.fibers]) {
      void fiber.dispose();
    }
    return runtime;
  }

  /**
   * Start a plugin below `parent` and return its awaitable fiber.
   *
   * @throws when the plugin shape is invalid, or when the parent fiber
   * already rejected new children.
   */
  load(parent: Context, plugin: Plugin): Fiber & PromiseLike<Fiber> {
    const callback = callbackOf(plugin);
    if (!callback) {
      throw new TypeError(
        `invalid plugin: expected a function or an object with an "apply" method, received ${typeof plugin}`,
      );
    }
    const runtime = this.ensureRuntime(plugin, callback);
    let fiber: Fiber;
    try {
      fiber = new Fiber({
        uid: this.allocateUid(),
        parent: parent.fiber,
        entry: { name: runtime.name, callback },
        context: (owner) => parent.derive(owner),
        onDetach: () => this.retire(runtime, fiber!),
      });
    } catch (reason) {
      // The parent rejected the child (for example, it is already
      // unloading): drop a runtime record that no fiber ever joined.
      if (runtime.fibers.length === 0) this.runtimes.delete(callback);
      throw reason;
    }
    runtime.fibers.push(fiber);
    return toAwaitable(fiber);
  }

  private runtimeOf(plugin: Plugin): PluginRuntime | undefined {
    const callback = callbackOf(plugin);
    return callback ? this.runtimes.get(callback) : undefined;
  }

  private ensureRuntime(plugin: Plugin, callback: PluginCallback): PluginRuntime {
    const existing = this.runtimes.get(callback);
    if (existing) return existing;
    const runtime: PluginRuntime = { name: pluginName(plugin), callback, fibers: [] };
    this.runtimes.set(callback, runtime);
    return runtime;
  }

  /** Remove one fiber from its runtime; forget the runtime when emptied. */
  private retire(runtime: PluginRuntime, fiber: Fiber): void {
    runtime.fibers = runtime.fibers.filter((live) => live !== fiber);
    if (runtime.fibers.length === 0) {
      this.runtimes.delete(runtime.callback);
    }
  }

  private allocateUid(): number {
    this.lastUid += 1;
    return this.lastUid;
  }
}

/** Resolve any supported plugin shape to its identifying callback. */
function callbackOf(plugin: Plugin): PluginCallback | undefined {
  try {
    if (typeof plugin === "function") return plugin;
    if (plugin && typeof (plugin as ObjectPlugin).apply === "function") {
      return (plugin as ObjectPlugin).apply;
    }
  } catch {
    // A hostile getter on `apply` makes the shape unresolvable.
  }
  return undefined;
}

function pluginName(plugin: Plugin): string | undefined {
  const name = (plugin as { name?: string }).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}
