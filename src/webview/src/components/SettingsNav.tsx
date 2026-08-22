// SettingsNav — the first-level settings menu that replaces the project
// sidebar while the settings view is open (reference shots 4/5): a back-to-
// chat row on top, then one entry per settings section. Pure content; the
// shell column (docked / rail / drawer) supplies background and borders.
// 自 1c 起分区清单从 settings.section 槽位派生（内置贡献由
// builtinSettingsSections 注册；SettingsSection 类型保留内置五值联合）。
import { ArrowLeft } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useSlotList } from "../slots/react";
import { NavRail } from "./NavRail";

export type SettingsSection = "models" | "general" | "plugins" | "appearance" | "about";

/** 设置分区槽位标识：每个分区一条贡献（list，注册序即清单序）。 */
export const SETTINGS_SECTION_SLOT = "settings.section";

/** 设置分区槽位的一条贡献：icon 采用图标组件类型（NavRail/菜单直接渲染）。 */
export interface SettingsSectionContribution {
  id: SettingsSection;
  labelKey: string;
  icon: LucideIcon;
  render: () => React.ReactNode;
}

/** 从槽位派生分区清单（注册序保序）。 */
export function useSettingsSections(): readonly SettingsSectionContribution[] {
  return useSlotList<SettingsSectionContribution>(SETTINGS_SECTION_SLOT);
}

interface Props {
  t: (key: string) => string;
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  onBack: () => void;
}

export function SettingsNav({ t, section, onSelect, onBack }: Props): React.JSX.Element {
  const sections = useSettingsSections();
  return (
    <nav className="flex h-full w-full flex-col overflow-hidden">
      <div className="px-2 pt-3 pb-2">
        <button
          type="button"
          onClick={onBack}
          className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm text-(--color-app-muted) hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
        >
          <ArrowLeft size={16} className="shrink-0" />
          <span className="truncate">{t("settings.backToChat")}</span>
        </button>
      </div>

      <div className="flex flex-col gap-0.5 px-2 pb-3">
        {sections.map(({ id, icon: Icon, labelKey }) => (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            className={`flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm transition-colors ${
              section === id
                ? "bg-(--color-app-accent-soft) font-medium text-(--color-app-accent)"
                : "text-(--color-app-text) hover:bg-(--color-app-bubble)"
            }`}
          >
            <Icon size={16} className="shrink-0 text-(--color-app-muted)" />
            <span className="truncate">{t(labelKey)}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

/** 设置态的图标轨（中窗/折叠态）：分区清单同样从槽位派生。 */
export function SettingsRail({ t, section, onSelect, onBack }: Props): React.JSX.Element {
  const sections = useSettingsSections();
  return (
    <NavRail
      top={{ icon: ArrowLeft, label: t("settings.backToChat"), onClick: onBack }}
      items={sections.map(({ id, icon, labelKey }) => ({
        icon,
        label: t(labelKey),
        onClick: () => onSelect(id),
        active: section === id,
      }))}
    />
  );
}
