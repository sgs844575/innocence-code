// pluginBoot staging 装载集成（T11 验收 + T12 单实例显式验收）：Node 级、
// 不起 Electron——经真实 staging 树（npm run build:plugins 产出）装载内核、
// 脊柱套件与至少 fs/shell 两插件。无 staging 的干净检出按 packaged-exit
// 先例设计性跳过。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { AgentSession, type SessionPlugin } from "@innocencecode/harness-electron";
import { createMockProvider } from "@innocencecode/provider-mock";
import {
  createPluginBoot,
  createSessionComposition,
  loadKernel,
  resetKernelCache,
  type PluginBoot,
} from "./pluginBoot";
import { stagingBootPaths } from "./staging-paths";

const paths = stagingBootPaths();
const stagingAvailable = existsSync(paths.kernelPath);
const maybeDescribe = stagingAvailable ? describe : describe.skip;

let boot: PluginBoot | undefined;
let userRoot: string | undefined;
afterAll(async () => {
  await boot?.dispose().catch(() => {});
  if (userRoot) rmSync(userRoot, { recursive: true, force: true });
});

async function ensureBoot(): Promise<PluginBoot> {
  if (!boot) {
    userRoot = mkdtempSync(path.join(tmpdir(), "ic-boot-user-"));
    boot = await createPluginBoot({
      kernelPath: paths.kernelPath,
      builtinRoot: paths.builtinRoot,
      userRoot,
      workspaceRoot: process.cwd(),
    });
  }
  return boot;
}

maybeDescribe("pluginBoot over the real staging tree", () => {
  it("loads the staging kernel (single module instance) with createScope", async () => {
    const b = await ensureBoot();
    expect(typeof b.kernel.createScope).toBe("function");
    expect(b.kernel.Context).toBeTypeOf("function");
    const scope = b.createSessionScope();
    expect(scope.ctx.fiber).not.toBe(b.root.fiber);
    await scope.dispose();
  });

  it("mounts fs and shell at the boot root through loader.create", async () => {
    const b = await ensureBoot();
    await b.mountAtRoot("fs");
    await b.mountAtRoot("shell");
    const names = b.root.tools.specs().map((spec) => spec.name).sort();
    // The root spine backed the disk-loaded plugins: their tools registered.
    expect(names).toContain("Bash");
    expect(names).toEqual(
      expect.arrayContaining(["Edit", "Glob", "Grep", "Read", "Write"]),
    );
  });

  it("boots a full session inside a route scope with disk-loaded fs/shell", async () => {
    const b = await ensureBoot();
    const fsPlugin = (await b.importPlugin("fs")) as SessionPlugin;
    const shellPlugin = (await b.importPlugin("shell")) as SessionPlugin;
    expect(fsPlugin.name).toBe("fs");
    expect(shellPlugin.name).toBe("shell");

    const scope = b.createSessionScope();
    let scopeCleaned = 0;
    scope.ctx.effect(() => () => { scopeCleaned += 1; }, "scope-probe");

    const session = await AgentSession.create({
      scope,
      // Production parity: the session mounts the SAME spine suite the boot
      // loaded from the staging tree (the runtime's sessionSpine hook).
      spine: b.spine,
      plugins: [fsPlugin, shellPlugin],
      provider: createMockProvider({ turns: [{ text: "ok" }] }),
      workspaceRoot: process.cwd(),
      permission: {
        mode: "auto",
        decider: { ask: async () => "deny" },
      },
    });
    const tools = [...session.registry.tools.keys()].sort();
    expect(tools).toContain("Bash");
    expect(tools).toContain("Read");
    // The session shadowed the boot root's spine names inside its scope.
    expect(scope.ctx.services.owns("tools")).toBe(true);

    const summary = await session.run("装载链探针");
    expect(summary.finalText).toBe("ok");
    await session.dispose();
    expect(scopeCleaned).toBe(1);
    expect(scope.ctx.fiber.state).toBe(b.kernel.FiberState.DISPOSED);
    // The boot root survives the route scope teardown.
    expect(b.root.fiber.state).toBe(b.kernel.FiberState.ACTIVE);
  });

  // ---- T12 单实例显式验收 ----------------------------------------------

  it("single instance: a staging plugin's KernelError passes the host-side instanceof", async () => {
    const b = await ensureBoot();
    // Fixture plugin below the boot's user root: its apply throws the STAGING
    // kernel's KernelError (imported by absolute file URL — the same module
    // loadKernel returned), so the identity check below is meaningful only
    // when plugin and host share ONE kernel module instance.
    const fixtureRoot = userRoot!;
    const fixtureDir = path.join(fixtureRoot, "kernel-error-fixture", "dist");
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      path.join(fixtureDir, "index.js"),
      [
        `import { KernelError } from ${JSON.stringify(pathToFileURL(paths.kernelPath).href)};`,
        `export default {`,
        `  name: "kernel-error-fixture",`,
        `  async apply() {`,
        `    throw new KernelError("DUPLICATE_SERVICE", "fixture probe");`,
        `  },`,
        `};`,
        "",
      ].join("\n"),
      "utf8",
    );

    let thrown: unknown;
    try {
      await b.mountAtRoot("kernel-error-fixture");
    } catch (error) {
      thrown = error;
    }
    // The loader surfaces the plugin's failure as its wrapped error's cause.
    const wrapped = thrown as { message?: string; cause?: unknown };
    expect(thrown).toBeInstanceOf(Error);
    expect(wrapped.message).toContain("failed to start loader entry");
    // The host side checks the class THROUGH loadKernel's module: true only
    // when the fixture resolved the same kernel module instance.
    expect(wrapped.cause).toBeInstanceOf(b.kernel.KernelError);
    expect((wrapped.cause as { code?: string }).code).toBe("DUPLICATE_SERVICE");
  });

  it("single instance: the boot spine and the staged spine modules are one and the same", async () => {
    const b = await ensureBoot();
    const staged = path.join(
      path.dirname(paths.kernelPath), "..", "..", "harness-tools", "dist", "index.js",
    );
    const stagedTools = (await import(pathToFileURL(staged).href)) as typeof import("@innocencecode/harness-tools");
    // Module-object identity: the suite the host mounts IS the module the
    // staging tree serves to disk-loaded plugins (no second spine copy).
    expect(b.spine.tools.ToolsPlugin).toBe(stagedTools.ToolsPlugin);
    expect(b.spine.tools.createExecutionScope).toBe(stagedTools.createExecutionScope);
    const loggerEntry = path.join(
      path.dirname(paths.kernelPath), "..", "..", "kernel-logger", "dist", "index.js",
    );
    const stagedLogger = (await import(pathToFileURL(loggerEntry).href)) as typeof import("@innocencecode/kernel-logger");
    expect(b.spine.logger.LoggerPlugin).toBe(stagedLogger.LoggerPlugin);
    // And the boot's mount face really registers through that staged spine.
    expect(b.root.tools.specs().length).toBeGreaterThan(0);
  });

  it("retry seam: failed loads are not memoized (kernelLoader + session composition)", async () => {
    // kernelLoader: a failed dynamic import must not poison the process memo.
    const missing = path.join(tmpdir(), "ic-missing-kernel", "dist", "index.js");
    resetKernelCache();
    await expect(loadKernel(missing)).rejects.toThrow();
    const kernel = await loadKernel(paths.kernelPath);
    expect(typeof kernel.createScope).toBe("function");
    expect(await loadKernel(paths.kernelPath)).toBe(kernel);

    // Session composition: a failed boot (unreadable manifest) clears the
    // memo, so the next composition attempt retries instead of replaying the
    // rejection; a subsequent good attempt succeeds.
    let attempt = 0;
    const composition = createSessionComposition({
      resolvePaths: () =>
        attempt++ === 0
          ? { kernelPath: paths.kernelPath, builtinRoot: path.join(tmpdir(), "ic-missing-plugins") }
          : { kernelPath: paths.kernelPath, builtinRoot: paths.builtinRoot },
      getWorkspaceRoot: () => undefined,
      log: () => {},
    });
    await expect(composition.ensureBoot()).rejects.toThrow(/manifest/);
    const retry = await composition.ensureBoot();
    expect(retry.kernel).toBe(kernel);
    await composition.disposePluginBoot();
  });
});

if (!stagingAvailable) {
  it.skip("staging tree not found — run `npm run build:plugins` then re-run to exercise the boot chain", () => {});
}
