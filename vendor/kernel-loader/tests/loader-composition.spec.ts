import { Context, FiberState } from "@innocencecode/kernel";
import { Loader, LoaderEntry } from "@innocencecode/kernel-loader";
import { Include } from "@innocencecode/kernel-include";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let context: Context | undefined;
let tempRoot: string | undefined;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "innocence-kernel-loader-"));
});

afterEach(async () => {
  if (context) { await context.fiber.dispose(); context = undefined; }
  if (tempRoot) { await rm(tempRoot, { recursive: true, force: true }); tempRoot = undefined; }
});

interface Harness {
  entries: Map<string, unknown>;
  register(name: string, plugin: unknown): void;
}

function createHarness(): Harness {
  const harness: Harness = {
    entries: new Map(),
    register(name, plugin) { harness.entries.set(name, plugin); },
  };
  return harness;
}

async function loadYaml(lines: readonly string[], harness: Harness): Promise<Context> {
  const configPath = join(tempRoot!, "entries.yml");
  await writeFile(configPath, [...lines, ""].join("\n"), "utf8");
  context = new Context();
  context.baseUrl = pathToFileURL(tempRoot!).href + "/";
  await context.plugin(Loader);
  context.loader.builtins.include = Include;
  context.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!harness.entries.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return harness.entries.get(specifier);
    },
  } as unknown as NonNullable<typeof context.loader.internal>;
  // "kernel:include" addresses the include builtin through the loader's registry.
  await context.loader.create({
    name: "kernel:include",
    config: { path: pathToFileURL(configPath).href },
  });
  await context.loader.await();
  return context;
}

// YAML entries live in the include entry's subtree with prefixed ids, so
// look them up by row id across the whole tree (the reference upstream spec
// iterates loader.entries() the same way instead of calling resolve()).
function findEntry(ctx: Context, id: string) {
  return [...ctx.loader.entries()].find((entry) => entry.options.id === id);
}

describe("kernel loader composition", () => {
  it("exposes the entry to its plugin while it applies", async () => {
    const h = createHarness();
    let entryAtApply: LoaderEntry | undefined;
    h.register("probe-entry", {
      name: "probe-entry",
      apply(pluginCtx: Context) { entryAtApply = pluginCtx.entry; },
    });
    await loadYaml([
      "- id: probe-entry",
      "  name: probe-entry",
      "  config: { tag: alpha }",
    ], h);
    // Kernel contract: the loader sets ctx.entry before the plugin body
    // runs, so plugins and carriers read their own config from it.
    const entry = findEntry(context!, "probe-entry");
    expect(entryAtApply).toBe(entry);
    expect(entryAtApply?.options.name).toBe("probe-entry");
    expect((entryAtApply?.options.config as { tag: string } | undefined)?.tag).toBe("alpha");
  });

  it("loads enabled entries and skips disabled ones", async () => {
    const h = createHarness();
    h.register("probe-a", { name: "probe-a", apply() {} });
    h.register("probe-b", { name: "probe-b", apply() { throw new Error("boom"); } });
    await loadYaml([
      "- id: probe-a",
      "  name: probe-a",
      "- id: probe-b",
      "  name: probe-b",
      "  disabled: true",
    ], h);
    const activeEntry = findEntry(context!, "probe-a");
    expect(activeEntry?.fiber?.state).toBe(FiberState.ACTIVE);
    const disabledEntry = findEntry(context!, "probe-b");
    expect(disabledEntry?.options.disabled).toBe(true);
    expect(disabledEntry?.fiber).toBeUndefined();
  });

  it("fails the loader composition await when an enabled entry cannot import", async () => {
    const h = createHarness();
    await expect(loadYaml([
      "- id: missing",
      "  name: missing-module",
    ], h)).rejects.toThrow(/missing-module|unexpected Loader import/);
  });
});
