// 内置设置分区贡献：五个分区（模型服务/通用/插件/外观/关于）注册进
// settings.section 槽位。分区内容自 SettingsView 原条件分发原样搬移
//（内容零改动）；分区依赖（t/settings/appInfo/回调）来自 App 状态——
// 贡献对象经 useMemo 只构造一次（引用稳定，满足 T2 list 槽位不重注册
// 契约），render 闭包经 ref 读取最新依赖（语言/设置更新即时生效）。
import { useMemo, useRef } from "react";
import { Cpu, SlidersHorizontal, Puzzle, Palette, Info } from "lucide-react";
import type { ReactNode } from "react";
import type { HarnessSettings } from "../../../../shared/ipc";
import { useRegisterList } from "../../slots/react";
import { SETTINGS_SECTION_SLOT, type SettingsSectionContribution } from "../SettingsNav";
import { AboutSection, AppearanceSection, GeneralSection } from "./BasicSections";
import { PluginsSection } from "./PluginsSection";
import { ProviderSettingsPage } from "./provider/ProviderSettingsPage";

/** 分区 render 的共享依赖（SettingsView 的 props 子集；settings 允许未加载）。 */
export interface SettingsSectionDeps {
  t: (key: string) => string;
  settings: HarnessSettings | null;
  appInfo: { version: string; platform: NodeJS.Platform } | null;
  onSettingsChange: (next: HarnessSettings) => void;
  onPickWorkspace: () => void;
}

/** 单条注册哑组件：每条贡献独立持钩（T3 范式）。 */
function Registrar({ contribution }: { contribution: SettingsSectionContribution }): React.JSX.Element | null {
  useRegisterList(SETTINGS_SECTION_SLOT, contribution);
  return null;
}

/** 挂载于 <SlotProvider> 内：五个内置分区按固定序注册；卸载时整体注销。 */
export function BuiltinSettingsSections({ deps }: { deps: SettingsSectionDeps }): React.JSX.Element {
  // latest ref：render 回调读取 props 的传播形态（依赖变化不触发重注册）。
  const latest = useRef(deps);
  latest.current = deps;
  const contributions = useMemo<readonly SettingsSectionContribution[]>(
    () => {
      const p = () => latest.current;
      // 内容零改动：基础四节共享的滚动容器从 SettingsView 原样迁入。
      const scroll = (children: ReactNode): ReactNode => (
        <div className="scrollbar-thin min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-xl px-[clamp(14px,4vw,24px)] py-5">{children}</div>
        </div>
      );
      return [
        {
          id: "models",
          labelKey: "settings.section.models",
          icon: Cpu,
          render: () => {
            const { settings, onSettingsChange } = p();
            return settings === null ? null : (
              <ProviderSettingsPage settings={settings} onSettingsChange={onSettingsChange} />
            );
          },
        },
        {
          id: "general",
          labelKey: "settings.section.general",
          icon: SlidersHorizontal,
          render: () => {
            const { t, settings, onSettingsChange, onPickWorkspace } = p();
            return settings === null ? null : scroll(
              <GeneralSection
                t={t}
                settings={settings}
                onSettingsChange={onSettingsChange}
                onPickWorkspace={onPickWorkspace}
              />,
            );
          },
        },
        {
          id: "plugins",
          labelKey: "settings.section.plugins",
          icon: Puzzle,
          render: () => {
            const { t, settings, onSettingsChange } = p();
            return settings === null ? null : scroll(
              <PluginsSection t={t} settings={settings} onSettingsChange={onSettingsChange} />,
            );
          },
        },
        {
          id: "appearance",
          labelKey: "settings.section.appearance",
          icon: Palette,
          render: () => {
            const { t, settings, onSettingsChange } = p();
            return settings === null ? null : scroll(
              <AppearanceSection t={t} settings={settings} onSettingsChange={onSettingsChange} />,
            );
          },
        },
        {
          id: "about",
          labelKey: "settings.section.about",
          icon: Info,
          render: () => {
            const { t, appInfo } = p();
            return scroll(<AboutSection t={t} appInfo={appInfo} />);
          },
        },
      ];
    },
    [],
  );
  return <>{contributions.map((c) => <Registrar key={c.id} contribution={c} />)}</>;
}
