// 本地 plugin-set/plugin-toggles 拷贝的钉死测试（T11 从 harness-core 迁
// 入 src/main；原件 T12 删除）：不依赖 staging，干净检出恒可跑——覆盖两
// 级覆盖/依赖连带/core 恒开与 yml 解析告警面。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPluginToggles,
  resolvePluginSet,
  type PluginDescriptor,
} from "./plugin-toggles-local";

const DESCRIPTORS: readonly PluginDescriptor[] = [
  { id: "fs", dependencies: [], core: true },
  { id: "shell", dependencies: [], core: true },
  { id: "subagent", dependencies: ["fs", "shell"] },
  { id: "skills", dependencies: ["fs"] },
  { id: "mcp", dependencies: [] },
  { id: "todo", dependencies: [] },
];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function workspaceWith(yml: string): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), "ic-toggles-"));
  roots.push(root);
  const file = path.join(root, ".innocence", "plugins.yml");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, yml, "utf8");
  return root;
}

describe("resolvePluginSet (local copy)", () => {
  it("defaults to everything active", () => {
    const resolved = resolvePluginSet(DESCRIPTORS);
    expect(resolved.active).toEqual(["fs", "shell", "subagent", "skills", "mcp", "todo"]);
    expect(resolved.skipped).toEqual([]);
    expect(resolved.warnings).toEqual([]);
  });

  it("project overrides user; core cannot be disabled", () => {
    const resolved = resolvePluginSet(
      DESCRIPTORS,
      { mcp: false, subagent: false },
      // shell 在 PluginToggleSource 的类型面之外（核心件无开关），这里以
      // 字面量直入驱动“core 不可关”告警路径（算法按键动态读取）。
      { mcp: true, shell: false } as never,
    );
    // mcp re-enabled by the project layer; shell (core) ignores the toggle.
    expect(resolved.active).toEqual(["fs", "shell", "skills", "mcp", "todo"]);
    expect(resolved.skipped).toEqual([
      { id: "subagent", reason: "disabled-by-config", via: "user" },
    ]);
    expect(resolved.warnings).toEqual([
      "plugin \"shell\" is core and cannot be disabled; ignoring project toggle",
    ]);
  });

  it("disabling a dependency transitively skips dependents", () => {
    // The builtin descriptor set has only core dependencies, so the
    // dependency-closure is pinned on a synthetic set (same algorithm).
    const synthetic: readonly PluginDescriptor[] = [
      { id: "base", dependencies: [] },
      { id: "middle", dependencies: ["base"] },
      { id: "leaf", dependencies: ["middle"] },
    ];
    const resolved = resolvePluginSet(synthetic, { base: false } as never);
    expect(resolved.active).toEqual([]);
    expect(resolved.skipped).toEqual([
      { id: "base", reason: "disabled-by-config", via: "user" },
      { id: "middle", reason: "dependency-disabled", via: "user" },
      { id: "leaf", reason: "dependency-disabled", via: "user" },
    ]);
  });

  it("warns on unknown toggle keys in both layers", () => {
    const resolved = resolvePluginSet(
      DESCRIPTORS,
      { nope: false } as never,
      { other: true } as never,
    );
    expect(resolved.warnings).toEqual([
      'unknown plugin toggle "nope" in user toggles; ignored',
      'unknown plugin toggle "other" in project toggles; ignored',
    ]);
    expect(resolved.active).toHaveLength(DESCRIPTORS.length);
  });
});

describe("loadPluginToggles (local copy)", () => {
  it("reads boolean toggles and ignores unknown keys with a warning", async () => {
    const warnings: string[] = [];
    const root = await workspaceWith(
      "plugins:\n  mcp: false\n  mystery: true\n  skills: not-a-bool\n",
    );
    const toggles = await loadPluginToggles(root, {
      logger: (level, msg) => {
        if (level === "warn") warnings.push(msg);
      },
    });
    expect(toggles).toEqual({ mcp: false });
    expect(warnings).toEqual([
      `unknown plugin toggle "mystery" in ${path.join(root, ".innocence", "plugins.yml")}; ignored`,
      `plugin toggle "skills" in ${path.join(root, ".innocence", "plugins.yml")} must be a boolean; ignored`,
    ]);
  });

  it("missing file resolves undefined silently; corrupt yaml warns", async () => {
    const warnings: string[] = [];
    const empty = mkdtempSync(path.join(tmpdir(), "ic-toggles-empty-"));
    roots.push(empty);
    expect(await loadPluginToggles(empty, { logger: () => {} })).toBeUndefined();
    expect(warnings).toEqual([]);

    const broken = await workspaceWith("plugins: [unbalanced\n");
    const result = await loadPluginToggles(broken, {
      logger: (level, msg) => {
        if (level === "warn") warnings.push(msg);
      },
    });
    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});
