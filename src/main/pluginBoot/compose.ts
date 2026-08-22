// Plugin boot composition: one host-owned kernel root (created through the
// dynamically loaded staging kernel), the registration spine mounted on it
// (through the dynamically loaded spine suite — the same staging module
// identities the disk-loaded capability plugins resolve against), the kernel
// loader plus its dual-root file resolver (user plugins dir first, then the
// built-in staging root), and the builtin-set resolution (manifest.json +
// two-level toggles via the local plugin-set copy). Capability plugins are
// imported through the resolver; route sessions mount them inside per-route
// kernel scopes (createSessionScope).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as KernelModule from "@innocencecode/kernel";
import type { SessionSpineSuite } from "@innocencecode/harness-electron";
import { loadKernelSuite } from "./spineLoader";
import type { Kernel } from "./kernelLoader";
import {
  loadPluginToggles,
  resolvePluginSet,
  type PluginDescriptor,
  type PluginToggleSource,
  type ResolvedPluginSet,
} from "../plugin-toggles-local";
import { projectPluginInventory, type PluginInventoryEntry } from "../plugin-inventory";

type KernelContext = KernelModule.Context;
type KernelScope = KernelModule.ScopeHandle;

/** One booted plugin host: the root context, loader and resolution helpers. */
export interface PluginBoot {
  /** The loaded kernel module (single instance; Context/createScope/... symbols). */
  readonly kernel: Kernel;
  /** The loaded spine suite (single instance; the mount face of this boot). */
  readonly spine: SessionSpineSuite;
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
   * An empty workspaceRoot skips the project layer (no cwd-relative reads).
   */
  resolveBuiltinSet(options: {
    workspaceRoot?: string;
    userToggles?: PluginToggleSource;
    logger?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
  }): Promise<ResolvedPluginSet>;
  /**
   * Manifest projection for the settings inventory (IPC plugins:list):
   * boot-time descriptor metadata + a FRESH resolveBuiltinSet run per call —
   * settings/toggle changes are reflected immediately, never a stale snapshot.
   */
  pluginInventory(options: {
    workspaceRoot?: string;
    userToggles?: PluginToggleSource;
  }): Promise<PluginInventoryEntry[]>;
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

/** Default user plugin root (`~/.innocence/plugins`): shared with the plugin
 *  scheme wiring so the loader resolver and the scheme serve the same roots. */
export function defaultUserPluginRoot(): string {
  return path.join(os.homedir(), ".innocence", "plugins");
}

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
    if (descriptor.title !== undefined && (typeof descriptor.title !== "string" || descriptor.title === "")) {
      throw new Error(`builtin plugin manifest malformed (${file}): bad title for "${descriptor.id}"`);
    }
    if (descriptor.client !== undefined && typeof descriptor.client !== "boolean") {
      throw new Error(`builtin plugin manifest malformed (${file}): bad client flag for "${descriptor.id}"`);
    }
    return {
      id: descriptor.id,
      dependencies: descriptor.dependencies,
      ...(descriptor.core === true ? { core: true } : {}),
      ...(typeof descriptor.title === "string" ? { title: descriptor.title } : {}),
      ...(descriptor.client === true ? { client: true } : {}),
    };
  });
}

/**
 * Boot the plugin host: load the staging kernel + spine suite (single
 * instances), mount the registration spine + loader on the root, attach the
 * dual-root resolver. Settings and per-workspace toggles are resolved per
 * session (settings rebuilds must observe fresh values), not captured here.
 */
export async function createPluginBoot(options: PluginBootOptions): Promise<PluginBoot> {
  const suite = await loadKernelSuite(options.kernelPath);
  const { kernel, spine, loader: loaderModule } = suite;
  const root = new kernel.Context();
  const userRoot = options.userRoot ?? defaultUserPluginRoot();
  if (options.workspaceRoot) root.baseUrl = options.workspaceRoot;

  // Registration spine (dynamically loaded from the same staging tree as the
  // kernel): the root-level skeleton exists so root-mounted plugins (loader
  // entries, smoke probes) can register; each route session still mounts its
  // own spine inside its scope and shadows these names. Root-level permission
  // asks have no UI to answer them — they fail closed (deny).
  await root.plugin(spine.logger.LoggerPlugin);
  await root.plugin(spine.tools.ToolsPlugin);
  await root.plugin(
    spine.permissions.createPermissionsPlugin(
      spine.permissions.createPermissionsService({ mode: "ask", decider: denyAllDecider }),
    ),
  );
  await root.plugin(spine.providers.ProvidersPlugin);
  await root.plugin(spine.skills.SkillsPlugin);
  await root.plugin(spine.systemPrompt.SystemPromptPlugin);
  await root.plugin(spine.agents.AgentsPlugin);

  const loaderFiber = await root.plugin(loaderModule.Loader);
  const loader = loaderFiber.ctx.loader;
  loader.internal = loaderModule.createFileModuleResolver({ roots: [userRoot, options.builtinRoot] });

  const descriptors = await readManifest(options.builtinRoot);

  // Shared resolution: manifest descriptors + project yml + user toggles. An
  // empty workspaceRoot means "no project layer" (the settings-inventory path
  // with no workspace picked) — never a cwd-relative plugins.yml read.
  const resolveBuiltinSet = async ({
    workspaceRoot,
    userToggles,
    logger,
  }: {
    workspaceRoot?: string;
    userToggles?: PluginToggleSource;
    logger?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
  }): Promise<ResolvedPluginSet> => {
    const project = workspaceRoot
      ? await loadPluginToggles(workspaceRoot, { logger: logger ?? (() => {}) })
      : undefined;
    return resolvePluginSet(descriptors, userToggles, project);
  };

  return {
    kernel,
    spine,
    root,
    builtinRoot: options.builtinRoot,
    userRoot,
    resolveBuiltinSet,
    async pluginInventory({ workspaceRoot, userToggles }) {
      // 现算投影：每次调用重跑解析（toggles 变更即时反映）；描述符本身
      // 是 boot 时的 manifest 快照（随 staging 树固定）。
      return projectPluginInventory(
        descriptors,
        await resolveBuiltinSet({ workspaceRoot, userToggles }),
      );
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
