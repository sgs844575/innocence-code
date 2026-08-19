/**
 * Declarative plugin set (spec B 3.1).
 *
 * Compose-time wiring resolves a descriptor list plus two toggle layers
 * (user settings, project `.innocence/plugins.yml`) into the set of plugins
 * the host should activate:
 *
 * - Default: every descriptor is active.
 * - Toggles: keys are plugin ids. Layers merge per key, user then project —
 *   a project key (including an explicit `true`) overrides the user key, so
 *   a project file can both narrow and re-enable the user's choice. The
 *   plugin is disabled only when the winning effective value is `false`;
 *   `via` records the layer that provided that winning value.
 * - `core` descriptors are always active; toggling them only warns.
 * - Disabling a dependency transitively skips its dependents
 *   (`dependency-disabled`, inheriting the disabling layer).
 * - Unknown toggle keys and unknown dependencies warn and are ignored.
 * - Dependency cycles warn and the involved plugins activate conservatively
 *   (Kahn topological closure: anything the sort cannot order is treated as
 *   cycle-entangled and activated).
 *
 * Host-agnostic by design: no Electron/React/DOM imports live here.
 */

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

function warnUnknownKeys(
  source: Toggles,
  layer: "user" | "project",
  knownIds: ReadonlySet<string>,
  warnings: string[],
): void {
  if (source === undefined) return;
  for (const key of Object.keys(source)) {
    if (!knownIds.has(key)) {
      warnings.push(`unknown plugin toggle "${key}" in ${layer} toggles; ignored`);
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
  warnUnknownKeys(user, "user", knownIds, warnings);
  warnUnknownKeys(project, "project", knownIds, warnings);

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

  // Whatever Kahn could not order is cycle-entangled: warn and activate
  // conservatively, unless a dependency outside the tangle was disabled.
  const remaining = [...byId.values()].filter((d) => !finalized.has(d.id));
  if (remaining.length > 0) {
    warnings.push(
      `plugin dependency cycle detected involving: ${remaining
        .map((d) => d.id)
        .join(", ")}; activating conservatively`,
    );
    for (const descriptor of remaining) {
      finalize(descriptor.id);
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
