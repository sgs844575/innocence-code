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

// staging manifest 的清单 id 集（fs/shell/subagent/skills/mcp/todo：内核
// 原生插件，name 与 id 同名；provider/task 等由组合层另行装配不进清单）。
const MANIFEST_IDS = ["fs", "shell", "subagent", "skills", "mcp", "todo"] as const;

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
    // 清单 id → 插件实例名；新增清单条目必须同步此映射与实例化分支。
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
});

if (!stagingAvailable) {
  // A visible reason next to the skip (vitest shows it.skip without one).
  it.skip("staging tree not found — run `npm run build:plugins` then re-run to exercise the boot composition", () => {});
}
