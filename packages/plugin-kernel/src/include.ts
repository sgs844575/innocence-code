import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Context } from "./context";
import type { EntryCreateOptions } from "./loader";
import type { ObjectPlugin } from "./registry";

/** Config accepted by the include builtin. */
export interface IncludeConfig {
  /** Entry-list file (YAML), resolved against `ctx.baseUrl`. */
  path: string;
}

/** Resolve the include file against the context base, defaulting to cwd. */
function resolveFilename(path: string, ctx: Context): string {
  const base = ctx.baseUrl ?? new URL(".", pathToFileURL(process.cwd()).href).href;
  return fileURLToPath(new URL(path, base));
}

/**
 * Loader builtin: mounts a YAML entry list as a subtree.
 *
 * Each row of the top-level array becomes a loader entry below this
 * plugin's own entry, so rows compose prefixed ids and unwind together
 * with the include fiber. Reading, parsing, and mounting failures fail
 * the include fiber and surface through the loader.
 */
export const Include: ObjectPlugin = {
  name: "include",
  async apply(ctx: Context) {
    const owner = ctx.entry;
    if (!owner) throw new Error("include requires a loader entry context");
    const config = owner.options.config as IncludeConfig | undefined;
    if (!config || typeof config.path !== "string") {
      throw new Error("include config requires a path");
    }
    const filename = resolveFilename(config.path, ctx);
    const content = await readFile(filename, "utf8");
    const data: unknown = parseYaml(content);
    if (!Array.isArray(data)) {
      throw new Error(`include file must contain a top-level entry array: ${filename}`);
    }
    for (const row of data) {
      if (!row || typeof row !== "object" || typeof (row as EntryCreateOptions).name !== "string") {
        throw new Error(`include rows must be objects with a name: ${filename}`);
      }
      await ctx.loader.create(row as EntryCreateOptions, owner);
    }
  },
};
