// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginsSection } from "./PluginsSection";
import { createT } from "../../lib/i18n";
import type { HarnessSettings } from "../../../../shared/ipc";

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

const SWITCH_NAMES = ["子代理", "技能", "MCP 服务器", "待办工具"];

describe("PluginsSection", () => {
  it("pluginToggles 缺省时四个开关默认全开", () => {
    render(<PluginsSection t={t} settings={baseSettings()} onSettingsChange={() => {}} />);
    for (const name of SWITCH_NAMES) {
      const toggle = screen.getByRole("switch", { name });
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    }
  });

  it("已关的开关显示为关，其余不受影响", () => {
    const settings = baseSettings({ pluginToggles: { subagent: false } });
    render(<PluginsSection t={t} settings={settings} onSettingsChange={() => {}} />);
    expect(screen.getByRole("switch", { name: "子代理" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "技能" }).getAttribute("aria-checked")).toBe("true");
  });

  it("关闭 MCP：回调合并语义——保留其他设置字段与已开关键，只追加 mcp:false", () => {
    const settings = baseSettings({ pluginToggles: { subagent: false } });
    const onSettingsChange = vi.fn();
    render(<PluginsSection t={t} settings={settings} onSettingsChange={onSettingsChange} />);
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
    render(<PluginsSection t={t} settings={settings} onSettingsChange={onSettingsChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "技能" }));
    expect(onSettingsChange).toHaveBeenCalledWith({
      ...settings,
      pluginToggles: { skills: true, todo: true },
    });
  });

  it("静态提示行可见：项目 plugins.yml 优先于此设置", () => {
    render(<PluginsSection t={t} settings={baseSettings()} onSettingsChange={() => {}} />);
    expect(screen.getByText(/plugins\.yml 优先/)).toBeTruthy();
  });
});
