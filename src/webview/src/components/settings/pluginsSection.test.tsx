// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginsSection } from "./PluginsSection";
import { createT } from "../../lib/i18n";
import type { HarnessSettings, PluginInventory } from "../../../../shared/ipc";

afterEach(cleanup);

const t = createT("zh-CN");

function baseSettings(overrides: Partial<HarnessSettings> = {}): HarnessSettings {
  return {
    profiles: [],
    activeProfileId: "__mock__",
    activeModel: "mock",
    workspaceRoot: "",
    permissionMode: "ask",
    themeMode: "dark",
    ...overrides,
  };
}

// 清单投影 mock（IPC plugins:list 载荷形状；title 即行 label）。
const INVENTORY: PluginInventory = [
  { id: "fs", title: "文件系统", core: true, client: false, state: "active", via: "default" },
  { id: "shell", title: "命令行", core: true, client: false, state: "active", via: "default" },
  { id: "subagent", title: "子代理", core: false, client: false, state: "active", via: "default" },
  { id: "skills", title: "技能", core: false, client: false, state: "active", via: "default" },
  { id: "mcp", title: "MCP 服务器", core: false, client: false, state: "active", via: "default" },
  { id: "todo", title: "待办工具", core: false, client: false, state: "active", via: "default" },
];

function entry(id: string, patch: Partial<PluginInventory[number]>): PluginInventory {
  return INVENTORY.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

const SWITCH_NAMES = ["子代理", "技能", "MCP 服务器", "待办工具"];

describe("PluginsSection（清单投影驱动）", () => {
  it("pluginToggles 缺省时四个开关默认全开", () => {
    render(
      <PluginsSection t={t} settings={baseSettings()} onSettingsChange={() => {}} inventory={INVENTORY} />,
    );
    for (const name of SWITCH_NAMES) {
      const toggle = screen.getByRole("switch", { name });
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    }
  });

  it("已关的开关显示为关，其余不受影响", () => {
    const settings = baseSettings({ pluginToggles: { subagent: false } });
    render(
      <PluginsSection t={t} settings={settings} onSettingsChange={() => {}} inventory={INVENTORY} />,
    );
    expect(screen.getByRole("switch", { name: "子代理" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "技能" }).getAttribute("aria-checked")).toBe("true");
  });

  it("关闭 MCP：回调合并语义——保留其他设置字段与已开关键，只追加 mcp:false", () => {
    const settings = baseSettings({ pluginToggles: { subagent: false } });
    const onSettingsChange = vi.fn();
    render(
      <PluginsSection t={t} settings={settings} onSettingsChange={onSettingsChange} inventory={INVENTORY} />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "MCP 服务器" }));
    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith({
      ...settings,
      pluginToggles: { subagent: false, mcp: false },
    });
  });

  it("重新打开技能开关：保留其余键的值", () => {
    const settings = baseSettings({ pluginToggles: { skills: false, todo: true } });
    const onSettingsChange = vi.fn();
    render(
      <PluginsSection t={t} settings={settings} onSettingsChange={onSettingsChange} inventory={INVENTORY} />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "技能" }));
    expect(onSettingsChange).toHaveBeenCalledWith({
      ...settings,
      pluginToggles: { skills: true, todo: true },
    });
  });

  it("静态提示行可见：项目 plugins.yml 优先于此设置", () => {
    render(
      <PluginsSection t={t} settings={baseSettings()} onSettingsChange={() => {}} inventory={INVENTORY} />,
    );
    expect(screen.getByText(/plugins\.yml 优先/)).toBeTruthy();
  });

  it("core 插件开关恒开禁用并带“内置”徽标，点击不上抛", () => {
    const onSettingsChange = vi.fn();
    render(
      <PluginsSection t={t} settings={baseSettings()} onSettingsChange={onSettingsChange} inventory={INVENTORY} />,
    );
    const fsToggle = screen.getByRole("switch", { name: "文件系统" }) as HTMLButtonElement;
    expect(fsToggle.getAttribute("aria-checked")).toBe("true");
    expect(fsToggle.disabled).toBe(true);
    expect(screen.getAllByText("内置")).toHaveLength(2); // fs + shell
    fireEvent.click(fsToggle); // 禁用态不触发写路径
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("状态徽标：active 已启用 / 配置停用灰 / 依赖连带提示", () => {
    const inventory = entry("mcp", { state: "disabled-by-config", via: "user" }).map((row) =>
      row.id === "subagent"
        ? { ...row, state: "dependency-disabled" as const, via: "project" as const }
        : row,
    );
    render(
      <PluginsSection t={t} settings={baseSettings()} onSettingsChange={() => {}} inventory={inventory} />,
    );
    expect(screen.getByText("已停用")).toBeTruthy();
    expect(screen.getByText("依赖停用")).toBeTruthy();
    expect(screen.getAllByText("已启用").length).toBe(4);
  });

  it("client 模块标记：有渲染层模块的条目带 UI 徽标", () => {
    render(
      <PluginsSection t={t} settings={baseSettings()} onSettingsChange={() => {}} inventory={entry("todo", { client: true })} />,
    );
    expect(screen.getAllByText("UI")).toHaveLength(1);
  });

  it("清单未返回（null）：骨架态，无开关无文案行", () => {
    render(<PluginsSection t={t} settings={baseSettings()} onSettingsChange={() => {}} inventory={null} />);
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByText(/plugins\.yml 优先/)).toBeNull();
  });

  it("空清单：空态提示", () => {
    render(<PluginsSection t={t} settings={baseSettings()} onSettingsChange={() => {}} inventory={[]} />);
    expect(screen.getByText("暂无插件")).toBeTruthy();
  });
});
