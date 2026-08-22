// @vitest-environment jsdom
// 设置分区槽位契约测试：内置五分区注册 → settings.section 清单（id/labelKey 序）
// + SettingsNav / SettingsRail / SettingsView 三消费方派生（断言强度等价原
// 硬编码清单与条件分发）+ 依赖更新不重注册（T2 引用稳定契约）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlotProvider, useSlotList } from "../../slots/react";
import { createT } from "../../lib/i18n";
import type { HarnessSettings, PluginInventory } from "../../../../shared/ipc";
import { BuiltinSettingsSections } from "./builtinSettingsSections";
import { SettingsView } from "../SettingsView";
import {
  SETTINGS_SECTION_SLOT,
  SettingsNav,
  SettingsRail,
  type SettingsSection,
  type SettingsSectionContribution,
} from "../SettingsNav";

afterEach(cleanup);

const t = createT("zh-CN");

const appInfo = { version: "1.2.3", platform: "win32" as const };

/** 插件清单投影 mock（IPC plugins:list 载荷；插件节数据源）。 */
const PLUGIN_INVENTORY: PluginInventory = [
  { id: "fs", title: "文件系统", core: true, client: false, state: "active", via: "default" },
  { id: "shell", title: "命令行", core: true, client: false, state: "active", via: "default" },
  { id: "subagent", title: "子代理", core: false, client: false, state: "active", via: "default" },
  { id: "skills", title: "技能", core: false, client: false, state: "active", via: "default" },
  { id: "mcp", title: "MCP 服务器", core: false, client: false, state: "active", via: "default" },
  { id: "todo", title: "待办工具", core: false, client: false, state: "active", via: "default" },
];

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

/** 探针捕获的槽位清单（每次渲染刷新；用于跨渲染比对快照身份）。 */
let listed: readonly SettingsSectionContribution[] = [];

/** 渲染期探针：捕获分区清单。 */
function Probe(): React.JSX.Element | null {
  listed = useSlotList<SettingsSectionContribution>(SETTINGS_SECTION_SLOT);
  return null;
}

/** 标准装配：Provider + 内置五分区注册（默认依赖）+ 单个消费方节点。 */
function mountSections(
  settings: HarnessSettings,
  child: React.ReactNode,
): ReturnType<typeof render> {
  return render(
    <SlotProvider>
      <BuiltinSettingsSections
        deps={{
          t,
          settings,
          appInfo,
          onSettingsChange: () => {},
          onPickWorkspace: () => {},
          pluginInventory: PLUGIN_INVENTORY,
        }}
      />
      {child}
    </SlotProvider>,
  );
}

describe("builtin settings section contributions", () => {
  it("五个内置分区按固定序注册（id/labelKey）", () => {
    mountSections(baseSettings(), <Probe />);
    expect(listed.map(({ id, labelKey }) => ({ id, labelKey }))).toEqual([
      { id: "models", labelKey: "settings.section.models" },
      { id: "general", labelKey: "settings.section.general" },
      { id: "plugins", labelKey: "settings.section.plugins" },
      { id: "appearance", labelKey: "settings.section.appearance" },
      { id: "about", labelKey: "settings.section.about" },
    ]);
  });

  it("依赖更新不重注册（清单快照身份不变），render 读取最新依赖", () => {
    const first = mountSections(baseSettings(), <Probe />);
    const before = listed;
    first.rerender(
      <SlotProvider>
        <BuiltinSettingsSections
          deps={{
            t,
            settings: baseSettings({ workspaceRoot: "D:\\demo\\proj" }),
            appInfo,
            onSettingsChange: () => {},
            onPickWorkspace: () => {},
            pluginInventory: PLUGIN_INVENTORY,
          }}
        />
        <SettingsView
          t={t}
          section="general"
          settings={baseSettings({ workspaceRoot: "D:\\demo\\proj" })}
          appInfo={appInfo}
          onSettingsChange={() => {}}
          onPickWorkspace={() => {}}
        />
        <Probe />
      </SlotProvider>,
    );
    expect(listed).toBe(before);
    expect(screen.getByText("D:\\demo\\proj")).toBeTruthy();
  });
});

describe("SettingsNav 槽位派生", () => {
  it("五分区按序渲染并上抛选择命令", () => {
    const onSelect = vi.fn();
    mountSections(
      baseSettings(),
      <SettingsNav t={t} section="models" onSelect={onSelect} onBack={() => {}} />,
    );
    const items = screen.getAllByRole("button", { name: /模型服务|通用|插件|外观|关于/ });
    expect(items.map((item) => item.textContent)).toEqual(["模型服务", "通用", "插件", "外观", "关于"]);
    fireEvent.click(screen.getByRole("button", { name: "插件" }));
    expect(onSelect).toHaveBeenCalledWith("plugins");
  });
});

describe("SettingsRail 槽位派生", () => {
  it("轨道按钮按序派生（aria-label）并标注激活态与返回入口", () => {
    const onSelect = vi.fn();
    mountSections(
      baseSettings(),
      <SettingsRail t={t} section="plugins" onSelect={onSelect} onBack={() => {}} />,
    );
    const names = ["模型服务", "通用", "插件", "外观", "关于"];
    for (const name of names) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-pressed")).toBe(name === "插件" ? "true" : "false");
    }
    fireEvent.click(screen.getByRole("button", { name: "外观" }));
    expect(onSelect).toHaveBeenCalledWith("appearance");
    expect(screen.getByRole("button", { name: "返回会话" })).toBeTruthy();
  });
});

describe("SettingsView 槽位分发", () => {
  const SECTION_LABEL: Record<SettingsSection, string> = {
    models: "模型服务",
    general: "通用",
    plugins: "插件",
    appearance: "外观",
    about: "关于",
  };

  /** 渲染指定分区的 SettingsView（Provider + 内置贡献装配）。 */
  function renderSection(section: SettingsSection): ReturnType<typeof render> {
    return mountSections(
      baseSettings(),
      <SettingsView
        t={t}
        section={section}
        settings={baseSettings()}
        appInfo={appInfo}
        onSettingsChange={() => {}}
        onPickWorkspace={() => {}}
      />,
    );
  }

  it("models → 模型服务整页（厂家列表 + 未选中占位）", () => {
    renderSection("models");
    expect(screen.getByText(SECTION_LABEL.models)).toBeTruthy();
    expect(screen.getByText("选择左侧厂家")).toBeTruthy();
  });

  it("general → 通用节（滚动容器内的工作区行）", () => {
    renderSection("general");
    expect(screen.getByText(SECTION_LABEL.general)).toBeTruthy();
    expect(screen.getByText("工作区")).toBeTruthy();
    expect(screen.getByText("工作区").closest(".scrollbar-thin")).toBeTruthy();
  });

  it("plugins → 插件节（四开关 + 项目配置优先提示）", () => {
    renderSection("plugins");
    expect(screen.getByText(SECTION_LABEL.plugins)).toBeTruthy();
    expect(screen.getByRole("switch", { name: "子代理" })).toBeTruthy();
    expect(screen.getByText(/plugins\.yml 优先/)).toBeTruthy();
  });

  it("appearance → 外观节（主题切换）", () => {
    renderSection("appearance");
    expect(screen.getByText(SECTION_LABEL.appearance)).toBeTruthy();
    expect(screen.getByText("主题")).toBeTruthy();
    expect(screen.getByRole("button", { name: "深色" })).toBeTruthy();
  });

  it("about → 关于节（应用名 + 版本号）", () => {
    renderSection("about");
    expect(screen.getByText(SECTION_LABEL.about)).toBeTruthy();
    expect(screen.getByText("InnocenceCode")).toBeTruthy();
    expect(screen.getByText("1.2.3")).toBeTruthy();
  });
});
