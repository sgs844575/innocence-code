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

import { composePlugins } from "./harnessGlue";

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
});
