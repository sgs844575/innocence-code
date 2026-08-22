// 清单投影纯函数的钉死测试：manifest 描述符（title/core/client）+
// resolvePluginSet 结果 → PluginsSection 消费的条目形状。不依赖 staging，
// 干净检出恒可跑。
import { describe, expect, it } from "vitest";
import { projectPluginInventory, type PluginInventoryEntry } from "./plugin-inventory";
import { resolvePluginSet, type PluginDescriptor } from "./plugin-toggles-local";

describe("projectPluginInventory (manifest + resolved set 投影)", () => {
  // 清单描述符（含 build:plugins 产出的 title/client 投影字段）。
  const RICH: readonly PluginDescriptor[] = [
    { id: "fs", dependencies: [], core: true, title: "文件系统工具", client: false },
    { id: "skills", dependencies: ["fs"], title: "技能加载器", client: true },
    { id: "mcp", dependencies: [], title: "外部工具服务器客户端" },
  ];

  it("默认全 active/via default，按描述符序合并 title/core/client", () => {
    const entries = projectPluginInventory(RICH, resolvePluginSet(RICH));
    expect(entries).toEqual<PluginInventoryEntry[]>([
      { id: "fs", title: "文件系统工具", core: true, client: false, state: "active", via: "default" },
      { id: "skills", title: "技能加载器", core: false, client: true, state: "active", via: "default" },
      { id: "mcp", title: "外部工具服务器客户端", core: false, client: false, state: "active", via: "default" },
    ]);
  });

  it("跳过项带原因与获胜层；依赖连带继承来源层", () => {
    const synthetic: readonly PluginDescriptor[] = [
      { id: "base", dependencies: [], title: "基座" },
      { id: "middle", dependencies: ["base"], title: "中层" },
      { id: "free", dependencies: [], title: "独立" },
    ];
    const resolved = resolvePluginSet(synthetic, { base: false } as never);
    const entries = projectPluginInventory(synthetic, resolved);
    expect(entries).toEqual<PluginInventoryEntry[]>([
      { id: "base", title: "基座", core: false, client: false, state: "disabled-by-config", via: "user" },
      { id: "middle", title: "中层", core: false, client: false, state: "dependency-disabled", via: "user" },
      { id: "free", title: "独立", core: false, client: false, state: "active", via: "default" },
    ]);
  });

  it("描述符缺 title 时回落 id（旧 manifest 兼容）", () => {
    const plain: readonly PluginDescriptor[] = [{ id: "todo", dependencies: [] }];
    const [entry] = projectPluginInventory(plain, resolvePluginSet(plain));
    expect(entry?.title).toBe("todo");
  });
});
