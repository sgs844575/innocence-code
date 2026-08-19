// 设置页"插件"节（spec B 3.3）：用户级插件开关——subagent/skills/mcp/todo
// 四键 Switch，形状复用基础节的 SettingRow + ui/Switch。项目级
// .innocence/plugins.yml 优先于此设置，故底部附静态说明行。
import type { HarnessSettings, PluginToggleSource } from "../../../../shared/ipc";
import { SettingRow } from "./BasicSections";
import { Switch } from "../ui/Switch";

const PLUGIN_TOGGLES: {
  key: keyof PluginToggleSource;
  labelKey: string;
  descKey: string;
}[] = [
  { key: "subagent", labelKey: "settings.plugins.subagent", descKey: "settings.plugins.subagentDesc" },
  { key: "skills", labelKey: "settings.plugins.skills", descKey: "settings.plugins.skillsDesc" },
  { key: "mcp", labelKey: "settings.plugins.mcp", descKey: "settings.plugins.mcpDesc" },
  { key: "todo", labelKey: "settings.plugins.todo", descKey: "settings.plugins.todoDesc" },
];

export function PluginsSection({
  t,
  settings,
  onSettingsChange,
}: {
  t: (key: string) => string;
  settings: HarnessSettings;
  onSettingsChange: (next: HarnessSettings) => void;
}): React.JSX.Element {
  const toggles = settings.pluginToggles;

  const setToggle = (key: keyof PluginToggleSource, value: boolean): void => {
    // 与外观节同款 patch 合并：只覆盖 pluginToggles 一个字段并合并已有键，
    // 其余设置（profiles/主题/语言等）原样透传，避免整对象覆盖丢字段。
    onSettingsChange({
      ...settings,
      pluginToggles: { ...toggles, [key]: value },
    });
  };

  return (
    <div className="card divide-y divide-(--color-app-hairline)">
      {PLUGIN_TOGGLES.map(({ key, labelKey, descKey }) => (
        <SettingRow key={key} label={t(labelKey)} desc={t(descKey)}>
          <Switch
            checked={toggles?.[key] !== false}
            onChange={(value) => setToggle(key, value)}
            aria-label={t(labelKey)}
          />
        </SettingRow>
      ))}
      <p className="px-3.5 py-3 text-xs text-(--color-app-muted)">{t("settings.plugins.note")}</p>
    </div>
  );
}
