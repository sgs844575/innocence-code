// Plugin boot composition: one host-owned kernel root (created through the
// dynamically loaded staging kernel), the registration spine mounted on it
// (static imports — the vite alias distribution stays until T12), the kernel
// loader plus its dual-root file resolver (user plugins dir first, then the
// built-in staging root), and the builtin-set resolution (manifest.json +
// two-level toggles via the local plugin-set copy). Capability plugins are
// imported through the resolver; route sessions mount them inside per-route
// kernel scopes (createSessionScope).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as KernelModule from "@innocencecode/kernel";
import { Loader, createFileModuleResolver } from "@innocencecode/kernel-loader";
import { LoggerPlugin } from "@innocencecode/kernel-logger";
import { AgentsPlugin } from "@innocencecode/harness-agent";
import {
  createPermissionsPlugin,
  createPermissionsService,
} from "@innocencecode/harness-permissions";
import { ProvidersPlugin } from "@innocencecode/harness-providers";
import { SkillsPlugin } from "@innocencecode/harness-skills";
import { SystemPromptPlugin } from "@innocencecode/harness-system-prompt";
import { ToolsPlugin } from "@innocencecode/harness-tools";
import { loadKernel, type Kernel } from "./kernelLoader";
import {
  loadPluginToggles,
  resolvePluginSet,
  type PluginDescriptor,
  type PluginToggleSource,
  type ResolvedPluginSet,
} from "../plugin-toggles-local";

type KernelContext = KernelModule.Context;
type KernelScope = KernelModule.ScopeHandle;

/** One booted plugin host: the root context, loader and resolution helpers. */
export interface PluginBoot {
  /** The loaded kernel module (single instance; Context/createScope/... symbols). */
  readonly kernel: Kernel;
  /** Boot root context: spine skeleton + loader live here for the app lifetime. */
  readonly root: KernelContext;
  /** Directory the builtin plugin set is resolved from (staging/plugins). */
  readonly builtinRoot: string;
  /** User plugin root (`~/.innocence/plugins` unless overridden). */
  readonly userRoot: string;
  /**
   * Resolve the builtin capability set for one workspace: manifest.json
   * descriptors + project `.innocence/plugins.yml` + user settings toggles
   * (project overrides user; core stays on — the local plugin-set semantics).
   */
  resolveBuiltinSet(options: {
    workspaceRoot: string;
    userToggles?: PluginToggleSource;
    logger?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
  }): Promise<ResolvedPluginSet>;
  /**
   * Import one builtin plugin module through the dual-root resolver: the
   * module's default export when it has one (plugin object, or the factory
   * for skills/mcp), else the namespace. Host code configures factories.
   */
  importPlugin(id: string): Promise<unknown>;
  /**
   * Mount one plugin-shaped builtin at the boot root via `loader.create`
   * (the full disk chain: resolver import → plugin-shape validation → apply
   * against the root spine). Factory builtins (skills/mcp) must instead be
   * configured by the host and mounted per session — mounting a bare factory
   * as a function plugin would silently register nothing.
   */
  mountAtRoot(id: string): Promise<void>;
  /** Create one route-session scope below the boot root (kernel createScope). */
  createSessionScope(): KernelScope;
  /** Unwind the boot root (app shutdown; cascades into live route scopes). */
  dispose(): Promise<void>;
}

/** Inputs of {@link createPluginBoot}. */
export interface PluginBootOptions {
  /** Absolute path of the staged kernel dist entry (dev or packaged). */
  kernelPath: string;
  /** Built-in plugin root (staging `plugins/` or packaged `resources/plugins`). */
  builtinRoot: string;
  /** User plugin root; defaults to `~/.innocence/plugins`. */
  userRoot?: string;
  /**
   * Default workspace root recorded as the boot root's baseUrl (diagnostics
   * and relative-path resolution anchor); per-session workspaces are resolved
   * per route by the runtime, not here.
   */
  workspaceRoot?: string;
}

/** Root-level permission decider: no UI exists at the boot root, so every
 *  ask fails closed. Route sessions carry their own UI-backed decider. */
const denyAllDecider = {
  ask: async () => "deny" as const,
};

/** Read and validate staging `manifest.json` (build:plugins artifact). */
async function readManifest(builtinRoot: string): Promise<PluginDescriptor[]> {
  const file = path.join(builtinRoot, "manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`builtin plugin manifest unreadable (${file}): ${String(err)}`);
  }
  const rows = (parsed as { plugins?: unknown }).plugins;
  if (!Array.isArray(rows)) {
    throw new Error(`builtin plugin manifest malformed (${file}): "plugins" must be an array`);
  }
  return rows.map((row) => {
    const descriptor = row as Partial<PluginDescriptor>;
    if (typeof descriptor.id !== "string" || !Array.isArray(descriptor.dependencies)) {
      throw new Error(`builtin plugin manifest malformed (${file}): bad descriptor`);
    }
    return {
      id: descriptor.id,
      dependencies: descriptor.dependencies,
      ...(descriptor.core === true ? { core: true } : {}),
    };
  });
}

/**
 * Boot the plugin host: load the staging kernel (single instance), mount the
 * registration spine + loader on the root, attach the dual-root resolver.
 * Settings and per-workspace toggles are resolved per session (settings
 * rebuilds must observe fresh values), not captured here.
 */
export async function createPluginBoot(options: PluginBootOptions): Promise<PluginBoot> {
  const kernel = await loadKernel(options.kernelPath);
  const root = new kernel.Context();
  const userRoot = options.userRoot ?? path.join(os.homedir(), ".innocence", "plugins");
  if (options.workspaceRoot) root.baseUrl = options.workspaceRoot;

  // Registration spine (static imports; the staged-distribution switch for
  // the spine is T12): the root-level skeleton exists so root-mounted plugins
  // (loader entries, smoke probes) can register; each route session still
  // mounts its own spine inside its scope and shadows these names. Root-level
  // permission asks have no UI to answer them — they fail closed (deny).
  await root.plugin(LoggerPlugin);
  await root.plugin(ToolsPlugin);
  await root.plugin(
    createPermissionsPlugin(
      createPermissionsService({ mode: "ask", decider: denyAllDecider }),
    ),
  );
  await root.plugin(ProvidersPlugin);
  await root.plugin(SkillsPlugin);
  await root.plugin(SystemPromptPlugin);
  await root.plugin(AgentsPlugin);

  const loaderFiber = await root.plugin(Loader);
  const loader = loaderFiber.ctx.loader;
  loader.internal = createFileModuleResolver({ roots: [userRoot, options.builtinRoot] });

  const descriptors = await readManifest(options.builtinRoot);

  return {
    kernel,
    root,
    builtinRoot: options.builtinRoot,
    userRoot,
    async resolveBuiltinSet({ workspaceRoot, userToggles, logger }) {
      const project = await loadPluginToggles(workspaceRoot, {
        logger: logger ?? (() => {}),
      });
      return resolvePluginSet(descriptors, userToggles, project);
    },
    async importPlugin(id: string): Promise<unknown> {
      // The loader validates the plugin shape (object with apply, or a
      // function — which is how the skills/mcp factory defaults pass).
      return loader.importPlugin(id);
    },
    async mountAtRoot(id: string): Promise<void> {
      await loader.create({ id: `boot-${id}`, name: id });
    },
    createSessionScope() {
      return kernel.createScope(root);
    },
    async dispose() {
      await root.fiber.dispose();
    },
  };
}
