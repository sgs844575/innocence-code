// composePlugins 集成（spec 4）：项目 plugins.yml + 用户开关 →
// resolvePluginSet → 按 active 声明式实例化。harnessGlue 只在模块加载期
// 触及 Electron（runtime 构造取 userData 路径），mock 掉即可在纯 Node 下
// 驱动真实组合根（真实 yml 读取、真实解析器、真实插件实例）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false, themeSource: "system", on: vi.fn() },
  BrowserWindow: class {},
}));

import { composePlugins, PLUGIN_DESCRIPTORS } from "./harnessGlue";

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

describe("composePlugins (declarative composition root)", () => {
  it("project yml wins, user toggles apply, core stays, todo registers", async () => {
    const ws = await tempWorkspace({ ".innocence/plugins.yml": "plugins:\n  mcp: false\n" });
    const names = (await composePlugins(ws, { subagent: false })).map((p) => p.name);
    expect(names).toContain("tools-fs");
    expect(names).toContain("tools-shell");
    expect(names).toContain("project-permission-rules");
    expect(names).toContain("todoPlugin");
    expect(names).toContain("plugin-skills"); // 未关的开关全部在场
    expect(names).not.toContain("plugin-mcp");
    expect(names).not.toContain("plugin-subagent");
  });

  it("skills:false omits the skills plugin; core stays on", async () => {
    const ws = await tempWorkspace({ ".innocence/plugins.yml": "plugins:\n  skills: false\n" });
    const names = (await composePlugins(ws)).map((p) => p.name);
    expect(names).not.toContain("plugin-skills");
    expect(names).toContain("tools-fs");
    expect(names).toContain("todoPlugin");
  });

  it("guard: descriptors and instantiation branches stay 1:1", async () => {
    const ws = await tempWorkspace({});
    const names = (await composePlugins(ws)).map((p) => p.name);
    // 描述符 id → 插件实例名；新增描述符必须同步此映射与实例化分支。
    const nameById: Record<string, string> = {
      fs: "tools-fs",
      shell: "tools-shell",
      subagent: "plugin-subagent",
      skills: "plugin-skills",
      mcp: "plugin-mcp",
      todo: "todoPlugin",
    };
    for (const { id } of PLUGIN_DESCRIPTORS) {
      expect(nameById[id], `descriptor "${id}" 缺少测试侧 id→name 映射`).toBeTruthy();
      expect(names, `descriptor "${id}" 未实例化`).toContain(nameById[id]);
    }
    // +1 = project-permission-rules（关系模型外，恒定注入）；多余的实例化
    // 分支（无对应描述符）同样会让计数失衡变红。
    expect(names).toContain("project-permission-rules");
    expect(names).toHaveLength(PLUGIN_DESCRIPTORS.length + 1);
  });
});
