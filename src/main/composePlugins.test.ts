// composePlugins 集成（spec 4）：项目 plugins.yml + 用户开关 →
// resolvePluginSet（本地拷贝）→ 按清单 id 从 staging 双根磁盘装载。
// T11 起组合根经 pluginBoot（动态 staging 内核 + FileModuleResolver）装
// 配，T12 起组合逻辑位于 pluginBoot/sessionComposition（Electron-free，
// 测试直接以 staging 路径构造，不再需要 electron mock）；测试因此需要
// 真实 staging 树（npm run build:plugins 产出）；无 staging 的干净检出按
// packaged-exit 先例设计性跳过。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSessionComposition } from "./pluginBoot";
import { stagingBootPaths } from "./staging-paths";

const stagingAvailable = existsSync(stagingBootPaths().kernelPath);
const maybeDescribe = stagingAvailable ? describe : describe.skip;

const composition = createSessionComposition({
  resolvePaths: stagingBootPaths,
  getWorkspaceRoot: () => undefined,
  log: () => {},
});
const composePlugins = (workspaceRoot: string, userToggles?: { subagent?: boolean; skills?: boolean; mcp?: boolean; todo?: boolean }) =>
  composition.composePlugins(workspaceRoot, userToggles);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function tempWorkspace(files: Record<string, string>): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), "ic-compose-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
  return root;
}

// staging manifest 的清单 id 集：六个能力插件（内核原生插件，name 与 id
// 同名且有实例化分支）+ example（渲染层示例插件：仅清单/投影面，无会话
// 实例化分支）。provider/task 等由组合层另行装配不进清单。
const MANIFEST_IDS = ["fs", "shell", "subagent", "skills", "mcp", "todo"] as const;
const INVENTORY_IDS = [...MANIFEST_IDS, "example"] as const;

maybeDescribe("composePlugins (declarative composition root)", () => {
  it("project yml wins, user toggles apply, core stays, todo registers", async () => {
    const ws = await tempWorkspace({ ".innocence/plugins.yml": "plugins:\n  mcp: false\n" });
    const names = (await composePlugins(ws, { subagent: false })).map((p) => p.name);
    expect(names).toContain("fs");
    expect(names).toContain("shell");
    expect(names).toContain("project-permission-rules");
    expect(names).toContain("todo");
    expect(names).toContain("skills"); // 未关的开关全部在场
    expect(names).not.toContain("mcp");
    expect(names).not.toContain("subagent");
  });

  it("skills:false omits the skills plugin; core stays on", async () => {
    const ws = await tempWorkspace({ ".innocence/plugins.yml": "plugins:\n  skills: false\n" });
    const names = (await composePlugins(ws)).map((p) => p.name);
    expect(names).not.toContain("skills");
    expect(names).toContain("fs");
    expect(names).toContain("todo");
  });

  it("guard: manifest ids and instantiation branches stay 1:1", async () => {
    const ws = await tempWorkspace({});
    const names = (await composePlugins(ws)).map((p) => p.name);
    // 清单能力 id → 插件实例名；新增能力条目必须同步此映射与实例化分支
    // （example 例外：渲染层示例插件，无会话装配，仅经清单投影驱动 client）。
    const nameById: Record<string, string> = {
      fs: "fs",
      shell: "shell",
      subagent: "subagent",
      skills: "skills",
      mcp: "mcp",
      todo: "todo",
    };
    for (const id of MANIFEST_IDS) {
      expect(nameById[id], `descriptor "${id}" 缺少测试侧 id→name 映射`).toBeTruthy();
      expect(names, `descriptor "${id}" 未实例化`).toContain(nameById[id]);
    }
    // +2 = project-permission-rules（关系模型外，恒定注入）与 provider（设置
    // 驱动的 provider 插件，每 session 组装）；多余的实例化分支（无对应
    // 描述符）同样会让计数失衡变红。
    expect(names).toContain("project-permission-rules");
    expect(names).toContain("provider");
    expect(names).toHaveLength(MANIFEST_IDS.length + 2);
  });

  // ---- pluginInventory（清单投影，PluginsSection 数据源）------------------

  it("inventory 默认全 active：按清单序、title 非空、core/client 标记齐全", async () => {
    const ws = await tempWorkspace({});
    const entries = await composition.pluginInventory({ workspaceRoot: ws });
    expect(entries.map((e) => e.id)).toEqual([...INVENTORY_IDS]);
    for (const entry of entries) {
      expect(entry.title, `"${entry.id}" 缺 title`).toMatch(/\S/);
      expect(typeof entry.client).toBe("boolean");
      expect(entry.state).toBe("active");
      expect(entry.via).toBe("default");
    }
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get("fs")?.core).toBe(true);
    expect(byId.get("shell")?.core).toBe(true);
    expect(byId.get("mcp")?.core).toBe(false);
    // example：渲染层示例插件——client 标记为真（dist/client.js 产出），
    // 是 webview 侧 client 装载链（innocence-plugin://example/dist/client.js）的数据源。
    expect(byId.get("example")).toMatchObject({ core: false, client: true, state: "active", via: "default" });
  });

  it("inventory 按当前 toggles 现算：用户关 mcp → disabled-by-config/user，项目 yml 关 subagent → via project", async () => {
    const ws = await tempWorkspace({ ".innocence/plugins.yml": "plugins:\n  subagent: false\n" });
    const entries = await composition.pluginInventory({
      workspaceRoot: ws,
      userToggles: { mcp: false },
    });
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get("mcp")).toMatchObject({ state: "disabled-by-config", via: "user" });
    expect(byId.get("subagent")).toMatchObject({ state: "disabled-by-config", via: "project" });
    expect(byId.get("skills")).toMatchObject({ state: "active" });
  });

  it("inventory 每次调用重跑解析（非 boot 快照）：改 toggles 立即反映", async () => {
    const ws = await tempWorkspace({});
    const before = await composition.pluginInventory({ workspaceRoot: ws, userToggles: { skills: false } });
    expect(before.find((e) => e.id === "skills")?.state).toBe("disabled-by-config");
    const after = await composition.pluginInventory({ workspaceRoot: ws });
    expect(after.find((e) => e.id === "skills")?.state).toBe("active");
  });

  it("inventory 空工作区无项目层：只看用户开关，不读 cwd 级 plugins.yml", async () => {
    const entries = await composition.pluginInventory({ workspaceRoot: "", userToggles: { todo: false } });
    expect(entries.find((e) => e.id === "todo")).toMatchObject({
      state: "disabled-by-config",
      via: "user",
    });
    expect(entries.find((e) => e.id === "mcp")?.state).toBe("active");
  });
});

if (!stagingAvailable) {
  // A visible reason next to the skip (vitest shows it.skip without one).
  it.skip("staging tree not found — run `npm run build:plugins` then re-run to exercise the boot composition", () => {});
}
