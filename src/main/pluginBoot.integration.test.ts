// pluginBoot staging 装载集成（T11 验收）：Node 级、不起 Electron——
// 经真实 staging 树（npm run build:plugins 产出）装载内核与至少 fs/shell
// 两插件。无 staging 的干净检出按 packaged-exit 先例设计性跳过。
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentSession, type SessionPlugin } from "@innocencecode/harness-electron";
import { createMockProvider } from "@innocencecode/provider-mock";
import { createPluginBoot, type PluginBoot } from "./pluginBoot";
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
});

if (!stagingAvailable) {
  it.skip("staging tree not found — run `npm run build:plugins` then re-run to exercise the boot chain", () => {});
}
