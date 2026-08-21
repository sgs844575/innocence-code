import { Context, FiberState } from "@innocencecode/kernel";
import { Loader } from "@innocencecode/kernel-loader";
import { Include } from "@innocencecode/kernel-include";
import { createFileModuleResolver } from "@innocencecode/kernel-loader";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let context: Context | undefined;
let tempRoot: string | undefined;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "innocence-resolver-"));
});

afterEach(async () => {
  if (context) { await context.fiber.dispose(); context = undefined; }
  if (tempRoot) { await rm(tempRoot, { recursive: true, force: true }); tempRoot = undefined; }
});

async function writePlugin(root: string, id: string, marker: string) {
  const dir = join(root, id, "dist");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.js"),
    `export default { name: "${id}", apply(ctx) { (ctx.plugins ??= []).push("${marker}"); } };\n`, "utf8");
}

describe("file module resolver", () => {
  it("prefers the earlier root (user shadows built-in)", async () => {
    const userRoot = join(tempRoot!, "user");
    const builtinRoot = join(tempRoot!, "builtin");
    await writePlugin(builtinRoot, "probe", "builtin");
    await writePlugin(userRoot, "probe", "user");
    const resolver = createFileModuleResolver({ roots: [userRoot, builtinRoot] });
    const loaded: string[] = [];
    context = new Context();
    (context as { plugins?: string[] }).plugins = loaded;
    const mod = (await resolver.import("probe")) as { default: { apply(c: unknown): void } };
    mod.default.apply(context);
    expect(loaded).toEqual(["user"]);
  });

  it("falls back to the only root containing the plugin", async () => {
    const builtinRoot = join(tempRoot!, "builtin");
    await writePlugin(builtinRoot, "solo", "builtin");
    const resolver = createFileModuleResolver({ roots: [join(tempRoot!, "user"), builtinRoot] });
    await expect(resolver.import("solo")).resolves.toBeTruthy();
  });

  it("caches module instances per specifier", async () => {
    const root = join(tempRoot!, "user");
    await writePlugin(root, "once", "m");
    const resolver = createFileModuleResolver({ roots: [root] });
    const a = await resolver.import("once");
    const b = await resolver.import("once");
    expect(a).toBe(b);
  });

  it("throws a descriptive error when no root has the plugin", async () => {
    const resolver = createFileModuleResolver({ roots: [join(tempRoot!, "user"), join(tempRoot!, "builtin")] });
    await expect(resolver.import("missing")).rejects.toThrow(/plugin not found: missing \(searched 2 roots\)/);
  });

  it("rejects empty roots at construction", () => {
    expect(() => createFileModuleResolver({ roots: [] })).toThrow(/at least one root/);
  });

  it("loads through the full loader chain from a directory root", async () => {
    const userRoot = join(tempRoot!, "user");
    await writePlugin(userRoot, "chain", "user");
    context = new Context();
    context.baseUrl = pathToFileURL(tempRoot!).href + "/";
    await context.plugin(Loader);
    context.loader.builtins.include = Include;
    context.loader.internal = createFileModuleResolver({ roots: [userRoot] });
    // The include builtin requires a top-level entry array (see the kernel-include
    // contract and loader-composition.spec.ts); rows mount into its subtree.
    const configPath = join(tempRoot!, "entries.yml");
    await writeFile(configPath, ["- id: chain", "  name: chain", ""].join("\n"), "utf8");
    await context.loader.create({ name: "kernel:include", config: { path: pathToFileURL(configPath).href } });
    await context.loader.await();
    // include 子树条目经 entries() 迭代断言 ACTIVE（既有范式）
    const entry = [...context.loader.entries()].find((e) => e.options.name === "chain");
    expect(entry?.fiber?.state).toBe(FiberState.ACTIVE);
  });
});
