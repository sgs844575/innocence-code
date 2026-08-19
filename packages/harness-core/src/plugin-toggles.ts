import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { PluginToggleSource } from "./plugin-set";
import type { Logger } from "./registry";

/**
 * Project-level plugin toggles (spec B 3.2): `<root>/.innocence/plugins.yml`.
 *
 * ```yaml
 * plugins:
 *   subagent: false
 *   skills: true
 *   mcp: false
 *   todo: true
 * ```
 *
 * Missing file -> undefined (silent). Corrupt yaml or wrong document shape
 * -> undefined plus a visible warning through the injectable logger.
 * Unknown plugin keys and non-boolean values warn and are ignored.
 * Host-agnostic: warnings go through `Logger` (console.warn fallback).
 */

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
  if (plugins === undefined || plugins === null) return undefined;
  if (typeof plugins !== "object" || Array.isArray(plugins)) {
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
