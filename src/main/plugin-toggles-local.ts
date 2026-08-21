// Host-local plugin-set / plugin-toggles logic (verbatim copy made at T11
// from the retired core package's plugin-set.ts and plugin-toggles.ts, whose
// package was deleted at T12): this module is now the canonical resolver —
// the host composition never imported those runtime values from the package
// anyway, so behavior is byte-identical.
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/** Severity sink shape (copied with the module). */
export type Logger = (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;

export interface PluginDescriptor {
  id: string;
  dependencies: string[];
  core?: boolean;
}

export interface PluginToggleSource {
  subagent?: boolean;
  skills?: boolean;
  mcp?: boolean;
  todo?: boolean;
}

export type PluginSkipReason = "disabled-by-config" | "dependency-disabled";
export type PluginToggleLayer = "user" | "project" | "default";

export interface SkippedPlugin {
  id: string;
  reason: PluginSkipReason;
  via: PluginToggleLayer;
}

export interface ResolvedPluginSet {
  active: string[];
  skipped: SkippedPlugin[];
  warnings: string[];
}

type Toggles = PluginToggleSource | undefined;

function toggleValue(source: Toggles, id: string): boolean | undefined {
  if (source === undefined) return undefined;
  const value = (source as Record<string, unknown>)[id];
  return typeof value === "boolean" ? value : undefined;
}

function warnToggleKeys(
  source: Toggles,
  layer: "user" | "project",
  knownIds: ReadonlySet<string>,
  warnings: string[],
): void {
  if (source === undefined) return;
  for (const [key, value] of Object.entries(source)) {
    if (!knownIds.has(key)) {
      warnings.push(`unknown plugin toggle "${key}" in ${layer} toggles; ignored`);
    } else if (typeof value !== "boolean") {
      warnings.push(
        `plugin toggle "${key}" in ${layer} toggles must be a boolean; ignored`,
      );
    }
  }
}

export function resolvePluginSet(
  descriptors: readonly PluginDescriptor[],
  user?: PluginToggleSource,
  project?: PluginToggleSource,
): ResolvedPluginSet {
  const warnings: string[] = [];

  const byId = new Map<string, PluginDescriptor>();
  for (const descriptor of descriptors) {
    if (byId.has(descriptor.id)) {
      warnings.push(
        `duplicate plugin descriptor "${descriptor.id}"; keeping the last definition`,
      );
    }
    byId.set(descriptor.id, descriptor);
  }

  const knownIds = new Set(byId.keys());
  warnToggleKeys(user, "user", knownIds, warnings);
  warnToggleKeys(project, "project", knownIds, warnings);

  // Direct pass: core stays active (toggle attempts only warn); per key the
  // project value overrides the user value and the plugin is disabled only
  // when that effective value is false, recording the winning layer.
  const direct = new Map<string, PluginToggleLayer>();
  for (const descriptor of byId.values()) {
    if (descriptor.core) {
      if (toggleValue(project, descriptor.id) === false) {
        warnings.push(
          `plugin "${descriptor.id}" is core and cannot be disabled; ignoring project toggle`,
        );
      }
      if (toggleValue(user, descriptor.id) === false) {
        warnings.push(
          `plugin "${descriptor.id}" is core and cannot be disabled; ignoring user toggle`,
        );
      }
      continue;
    }
    const projectValue = toggleValue(project, descriptor.id);
    const userValue = toggleValue(user, descriptor.id);
    const effective = projectValue !== undefined ? projectValue : userValue;
    if (effective === false) {
      direct.set(descriptor.id, projectValue !== undefined ? "project" : "user");
    }
  }

  const skipped = new Map<string, SkippedPlugin>();
  for (const [id, layer] of direct) {
    skipped.set(id, { id, reason: "disabled-by-config", via: layer });
  }

  // Kahn topological closure over the not-directly-disabled subgraph. Edges
  // to directly disabled or unknown dependencies are excluded up front; the
  // skip check at pop time propagates transitive dependency-disabled states.
  const dependents = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const descriptor of byId.values()) {
    if (direct.has(descriptor.id)) continue;
    let degree = 0;
    for (const dep of descriptor.dependencies) {
      const dependency = byId.get(dep);
      if (dependency === undefined) {
        warnings.push(
          `plugin "${descriptor.id}" depends on unknown plugin "${dep}"; treating as satisfied`,
        );
        continue;
      }
      if (direct.has(dep)) continue;
      degree++;
      const list = dependents.get(dep);
      if (list === undefined) dependents.set(dep, [descriptor.id]);
      else list.push(descriptor.id);
    }
    inDegree.set(descriptor.id, degree);
  }

  const activeSet = new Set<string>();
  const finalized = new Set<string>(direct.keys());
  const queue: string[] = [];
  for (const descriptor of byId.values()) {
    if (!direct.has(descriptor.id) && inDegree.get(descriptor.id) === 0) {
      queue.push(descriptor.id);
    }
  }

  const finalize = (id: string): void => {
    finalized.add(id);
    const descriptor = byId.get(id);
    if (descriptor === undefined || descriptor.core) {
      // Core plugins are always active regardless of dependency state.
      activeSet.add(id);
      return;
    }
    const badDep = descriptor.dependencies.find((dep) => skipped.has(dep));
    if (badDep === undefined) {
      activeSet.add(id);
    } else {
      skipped.set(id, {
        id,
        reason: "dependency-disabled",
        via: skipped.get(badDep)!.via,
      });
    }
  };

  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    finalize(id);
    for (const dependent of dependents.get(id) ?? []) {
      const degree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, degree);
      if (degree === 0 && !finalized.has(dependent)) {
        queue.push(dependent);
      }
    }
  }

  // Whatever Kahn cannot order is cycle-entangled. Skip propagation runs to
  // a fixed point over that set so the outcome cannot depend on descriptor
  // declaration order; only the survivors activate conservatively.
  const leftover = [...byId.values()].filter((d) => !finalized.has(d.id));
  if (leftover.length > 0) {
    warnings.push(
      `plugin dependency cycle detected involving: ${leftover
        .map((d) => d.id)
        .join(", ")}; toggle and dependency rules still apply`,
    );
    let grew = true;
    while (grew) {
      grew = false;
      for (const descriptor of leftover) {
        if (finalized.has(descriptor.id) || descriptor.core) continue;
        const badDep = descriptor.dependencies.find((dep) => skipped.has(dep));
        if (badDep !== undefined) {
          skipped.set(descriptor.id, {
            id: descriptor.id,
            reason: "dependency-disabled",
            via: skipped.get(badDep)!.via,
          });
          finalized.add(descriptor.id);
          grew = true;
        }
      }
    }
    for (const descriptor of leftover) {
      if (!finalized.has(descriptor.id)) finalize(descriptor.id);
    }
  }

  const active: string[] = [];
  const skippedList: SkippedPlugin[] = [];
  for (const descriptor of byId.values()) {
    if (activeSet.has(descriptor.id)) active.push(descriptor.id);
    else if (skipped.has(descriptor.id)) skippedList.push(skipped.get(descriptor.id)!);
  }

  return { active, skipped: skippedList, warnings };
}

const KNOWN_TOGGLE_KEYS: readonly string[] = ["subagent", "skills", "mcp", "todo"];

export interface PluginTogglesOptions {
  logger?: Logger;
}

const consoleLogger: Logger = (level, msg, data) => {
  const sink = level === "error" ? console.error : console.warn;
  if (data === undefined) sink(msg);
  else sink(msg, data);
};

export async function loadPluginToggles(
  root: string,
  options: PluginTogglesOptions = {},
): Promise<PluginToggleSource | undefined> {
  const log = options.logger ?? consoleLogger;
  const file = path.join(root, ".innocence", "plugins.yml");

  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    log("warn", `failed to read ${file}; ignoring project plugin toggles`, err);
    return undefined;
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    log("warn", `failed to parse ${file} as yaml; ignoring project plugin toggles`, err);
    return undefined;
  }

  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    log("warn", `${file} must be a yaml mapping; ignoring project plugin toggles`);
    return undefined;
  }

  const plugins = (doc as Record<string, unknown>).plugins;
  if (plugins === undefined) return undefined;
  if (plugins === null || typeof plugins !== "object" || Array.isArray(plugins)) {
    log("warn", `"plugins" in ${file} must be a mapping; ignoring project plugin toggles`);
    return undefined;
  }

  const toggles: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    if (!KNOWN_TOGGLE_KEYS.includes(key)) {
      log("warn", `unknown plugin toggle "${key}" in ${file}; ignored`);
      continue;
    }
    if (typeof value !== "boolean") {
      log("warn", `plugin toggle "${key}" in ${file} must be a boolean; ignored`);
      continue;
    }
    toggles[key] = value;
  }
  return toggles;
}
