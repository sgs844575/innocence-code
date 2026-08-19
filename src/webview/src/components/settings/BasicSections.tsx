// 设置页的基础三节（通用 / 外观 / 关于）+ 共享行组件——从 SettingsView
// 原样迁入（行为不变），SettingsView 只做节分发。
import type {
  HarnessSettings,
  PermissionMode,
  ThemeMode,
} from "../../../../shared/ipc";

// ---- 通用 ------------------------------------------------------------------

export function GeneralSection({
  t,
  settings,
  onSettingsChange,
  onPickWorkspace,
}: {
  t: (key: string) => string;
  settings: HarnessSettings;
  onSettingsChange: (next: HarnessSettings) => void;
  onPickWorkspace: () => void;
}): React.JSX.Element {
  return (
    <div className="card divide-y divide-(--color-app-hairline)">
      <SettingRow label={t("settings.general.workspace")} desc={t("settings.general.workspaceDesc")}>
        <div className="flex min-w-0 items-center gap-2">
          <code
            className="min-w-0 max-w-56 truncate font-mono text-xs text-(--color-app-muted)"
            title={settings.workspaceRoot || undefined}
          >
            {settings.workspaceRoot || t("workspace.none")}
          </code>
          <button
            type="button"
            onClick={onPickWorkspace}
            className="shrink-0 rounded-full border border-(--color-app-border) px-2.5 py-1 text-xs hover:bg-(--color-app-bubble)"
          >
            {t("settings.general.change")}
          </button>
        </div>
      </SettingRow>
      <SettingRow label={t("settings.general.permission")} desc={t("settings.general.permissionDesc")}>
        <select
          value={settings.permissionMode}
          onChange={(e) =>
            onSettingsChange({
              ...settings,
              permissionMode: e.target.value as PermissionMode,
            })
          }
          className="rounded-xl border border-(--color-app-hairline) bg-(--color-app-bubble) px-3 py-1.5 text-sm outline-none"
        >
          <option value="auto">{t("permission.mode.auto")}</option>
          <option value="ask">{t("permission.mode.ask")}</option>
          <option value="plan">{t("permission.mode.plan")}</option>
        </select>
      </SettingRow>
    </div>
  );
}

// ---- 外观 ------------------------------------------------------------------

const THEME_OPTIONS: { value: ThemeMode; key: string }[] = [
  { value: "system", key: "settings.theme.system" },
  { value: "light", key: "settings.theme.light" },
  { value: "dark", key: "settings.theme.dark" },
];

export function AppearanceSection({
  t,
  settings,
  onSettingsChange,
}: {
  t: (key: string) => string;
  settings: HarnessSettings;
  onSettingsChange: (next: HarnessSettings) => void;
}): React.JSX.Element {
  const theme = settings.themeMode ?? "system";
  const locale = settings.locale ?? "";

  return (
    <div className="card divide-y divide-(--color-app-hairline)">
      <SettingRow label={t("settings.appearance.theme")}>
        <div className="flex gap-1 rounded-full bg-(--color-app-bubble) p-1">
          {THEME_OPTIONS.map(({ value, key }) => (
            <button
              key={value}
              type="button"
              onClick={() => onSettingsChange({ ...settings, themeMode: value })}
              className={`rounded-full px-3 py-1 text-xs transition-colors ${
                theme === value
                  ? "bg-(--color-app-panel) font-medium text-(--color-app-text) shadow-(--shadow-card)"
                  : "text-(--color-app-muted) hover:text-(--color-app-text)"
              }`}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow label={t("settings.appearance.language")}>
        <select
          value={locale}
          onChange={(e) =>
            onSettingsChange({
              ...settings,
              locale: e.target.value as HarnessSettings["locale"],
            })
          }
          className="rounded-xl border border-(--color-app-hairline) bg-(--color-app-bubble) px-3 py-1.5 text-sm outline-none"
        >
          <option value="">{t("settings.language.system")}</option>
          <option value="zh-CN">{t("settings.language.zhCN")}</option>
          <option value="en-US">{t("settings.language.enUS")}</option>
        </select>
      </SettingRow>
    </div>
  );
}

// ---- 关于 ------------------------------------------------------------------

export function AboutSection({
  t,
  appInfo,
}: {
  t: (key: string) => string;
  appInfo: { version: string; platform: NodeJS.Platform } | null;
}): React.JSX.Element {
  return (
    <div className="card divide-y divide-(--color-app-hairline)">
      <div className="flex flex-col items-center gap-1.5 px-4 py-6 text-center">
        <span aria-hidden className="font-mono text-2xl font-bold text-(--color-app-accent)">
          &gt;_
        </span>
        <span className="text-base font-semibold">InnocenceCode</span>
        <span className="text-xs text-(--color-app-muted)">{t("settings.about.desc")}</span>
      </div>
      <SettingRow label={t("settings.about.version")}>
        <span className="font-mono text-sm text-(--color-app-muted)">
          {appInfo?.version ?? "—"}
        </span>
      </SettingRow>
      <SettingRow label={t("settings.about.platform")}>
        <span className="font-mono text-sm text-(--color-app-muted)">
          {appInfo?.platform ?? "—"}
        </span>
      </SettingRow>
    </div>
  );
}

// ---- 共享小组件 --------------------------------------------------------------

export function SettingRow({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-3">
      <div className="min-w-0">
        <p className="text-sm">{label}</p>
        {desc && <p className="mt-0.5 text-xs text-(--color-app-muted)">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
