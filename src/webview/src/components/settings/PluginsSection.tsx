// 设置页"插件"节：清单投影驱动（IPC plugins:list → App 层拉取经 props 传入，
// null = 未返回）。每条目 = 开关（core 恒开禁用 + "内置"徽标）+ title +
// 状态徽标（active 绿点 / 停用灰 / 依赖连带提示）+ client 模块标记；行
// 形状复用基础节的 SettingRow + ui/Switch。开关写路径语义与硬编码版完全
// 一致：checked !== false，setToggle 只 patch pluginToggles 并上抛整份
// settings。项目级 .innocence/plugins.yml 优先于此设置，底部附静态说明行。
import type {
  HarnessSettings,
  PluginInventory,
  PluginInventoryEntry,
  PluginToggleSource,
} from "../../../../shared/ipc";
import { SettingRow } from "./BasicSections";
import { Switch } from "../ui/Switch";

/** 状态徽标行：绿点（active）/ 灰点 + 文案（停用 / 依赖连带停用）。 */
function StatusLine({
  t,
  entry,
}: {
  t: (key: string) => string;
  entry: PluginInventoryEntry;
}): React.JSX.Element {
  const active = entry.state === "active";
  const text =
    entry.state === "dependency-disabled"
      ? t("settings.plugins.dependencyDisabled")
      : active
        ? t("settings.plugins.stateActive")
        : t("settings.plugins.stateDisabled");
  return (
    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-(--color-app-muted)">
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${
          active ? "bg-(--color-app-accent)" : "bg-(--color-app-border)"
        }`}
      />
      {text}
    </span>
  );
}

/** 行右缘小徽标（client 模块 / 内置）。 */
function Badge({ text }: { text: string }): React.JSX.Element {
  return (
    <span className="rounded-full border border-(--color-app-hairline) px-1.5 py-0.5 text-[10px] leading-none text-(--color-app-muted)">
      {text}
    </span>
  );
}

/** 清单未返回时的骨架（无开关、无文案行，避免闪烁出旧状态）。 */
function InventorySkeleton(): React.JSX.Element {
  return (
    <div className="card divide-y divide-(--color-app-hairline)" aria-hidden>
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center justify-between gap-4 px-3.5 py-3">
          <div className="h-4 w-40 animate-pulse rounded bg-(--color-app-bubble)" />
          <div className="h-4 w-7 animate-pulse rounded-full bg-(--color-app-bubble)" />
        </div>
      ))}
    </div>
  );
}

export function PluginsSection({
  t,
  settings,
  onSettingsChange,
  inventory,
}: {
  t: (key: string) => string;
  settings: HarnessSettings;
  onSettingsChange: (next: HarnessSettings) => void;
  /** 清单投影（App 层拉取）；null = 未返回（骨架态），[] = 空清单。 */
  inventory: PluginInventory | null;
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

  if (inventory === null) return <InventorySkeleton />;

  return (
    <div className="card divide-y divide-(--color-app-hairline)">
      {inventory.length === 0 ? (
        <p className="px-3.5 py-6 text-center text-sm text-(--color-app-muted)">
          {t("settings.plugins.empty")}
        </p>
      ) : (
        inventory.map((entry) => {
          // 清单 id 与 PluginToggleSource 键空间镜像一致（mirror 有 drift-guard）。
          const key = entry.id as keyof PluginToggleSource;
          return (
            <SettingRow key={entry.id} label={entry.title} desc={<StatusLine t={t} entry={entry} />}>
              <div className="flex items-center gap-2">
                {entry.client && <Badge text={t("settings.plugins.clientBadge")} />}
                {entry.core && <Badge text={t("settings.plugins.builtin")} />}
                <Switch
                  checked={entry.core ? true : toggles?.[key] !== false}
                  onChange={(value) => setToggle(key, value)}
                  disabled={entry.core}
                  aria-label={entry.title}
                />
              </div>
            </SettingRow>
          );
        })
      )}
      <p className="px-3.5 py-3 text-xs text-(--color-app-muted)">{t("settings.plugins.note")}</p>
    </div>
  );
}
