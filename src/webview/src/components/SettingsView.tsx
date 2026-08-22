// Settings content area — renders the section picked in SettingsNav.
// 自 1c 起只做槽位消费：按当前分区 id 从 settings.section 槽位找贡献，
// 标题（labelKey）与内容（render）均出自贡献（SECTION_TITLE_KEY 已随迁）；
// 分区组件实现在 builtinSettingsSections 注册。
import type { HarnessSettings } from "../../../shared/ipc";
import { useSettingsSections, type SettingsSection } from "./SettingsNav";

interface Props {
  t: (key: string) => string;
  section: SettingsSection;
  settings: HarnessSettings;
  appInfo: { version: string; platform: NodeJS.Platform } | null;
  onSettingsChange: (next: HarnessSettings) => void;
  onPickWorkspace: () => void;
}

// 对外 props 形态不变（宿主接线零改动）：settings/appInfo/回调不再被本组件
// 消费——分区内容经槽位贡献的 render 闭包持有（App 侧 BuiltinSettingsSections
// 的 deps 传播同一批值），仅为兼容既有调用方保留在接口上。
export function SettingsView({ t, section }: Props): React.JSX.Element | null {
  const sections = useSettingsSections();
  const active = sections.find((s) => s.id === section);
  // 分区未注册（缺 Provider/内置贡献）时无可渲染内容——正常运行不发生。
  if (active === undefined) return null;
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center border-b border-(--color-app-hairline) px-4 text-sm font-medium">
        {t(active.labelKey)}
      </header>
      {active.render()}
    </div>
  );
}
