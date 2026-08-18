// Settings content area — renders the section picked in SettingsNav:
// models (cherry-style provider list + detail pane), general
// (workspace + permission mode), appearance (theme + language), about.
import { useEffect, useRef, useState } from "react";
import type {
  HarnessSettings,
  PermissionMode,
  ProviderProfile,
  ThemeMode,
} from "../../../shared/ipc";
import type { SettingsSection } from "./SettingsNav";
import { api } from "../lib/ipc";
import { ProviderDetail } from "./settings/provider/ProviderDetail";
import { ProviderList } from "./settings/provider/ProviderList";

const MOCK_PROFILE_ID = "__mock__";
const MOCK_MODEL = "mock";

interface Props {
  t: (key: string) => string;
  section: SettingsSection;
  settings: HarnessSettings;
  appInfo: { version: string; platform: NodeJS.Platform } | null;
  onSettingsChange: (next: HarnessSettings) => void;
  onPickWorkspace: () => void;
}

const SECTION_TITLE_KEY: Record<SettingsSection, string> = {
  models: "settings.section.models",
  general: "settings.section.general",
  appearance: "settings.section.appearance",
  about: "settings.section.about",
};

export function SettingsView({
  t,
  section,
  settings,
  appInfo,
  onSettingsChange,
  onPickWorkspace,
}: Props): React.JSX.Element {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center border-b border-(--color-app-hairline) px-4 text-sm font-medium">
        {t(SECTION_TITLE_KEY[section])}
      </header>

      {section === "models" ? (
        <ModelsSection settings={settings} onSettingsChange={onSettingsChange} />
      ) : (
        <div className="scrollbar-thin min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-xl px-[clamp(14px,4vw,24px)] py-5">
            {section === "general" && (
              <GeneralSection
                t={t}
                settings={settings}
                onSettingsChange={onSettingsChange}
                onPickWorkspace={onPickWorkspace}
              />
            )}
            {section === "appearance" && (
              <AppearanceSection t={t} settings={settings} onSettingsChange={onSettingsChange} />
            )}
            {section === "about" && <AboutSection t={t} appInfo={appInfo} />}
          </div>
        </div>
      )}
    </div>
  );
}

let seq = 0;
const newId = () => `custom_${Date.now().toString(36)}_${(seq++).toString(36)}`;

// ---- 模型服务：cherry 式厂家列表栏 + 详情（详情面板在任务 2 接入） -------------

function ModelsSection({
  settings,
  onSettingsChange,
}: {
  settings: HarnessSettings;
  onSettingsChange: (next: HarnessSettings) => void;
}): React.JSX.Element {
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  // 详情面板的轻提示（连接检查等）：4 秒后自清，App 的 showError 通道不进设置页。
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string): void => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const patchProfiles = (profiles: ProviderProfile[]): void =>
    onSettingsChange({ ...settings, profiles });

  /** 详情面板字段编辑：patch 合并进该 id 的条目后全量提交。 */
  const patchProfile = (id: string) => (patch: Partial<ProviderProfile>): void =>
    patchProfiles(settings.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const listModels = (profile: ProviderProfile): Promise<string[]> =>
    api.listProviderModels(profile.id);

  const active = settings.profiles.find((p) => p.id === settings.activeProfileId);

  /** 选中即切换会话所用厂家；模型沿用同 id 项，否则取首个，无模型回 mock。 */
  const setActive = (id: string): void => {
    if (id === settings.activeProfileId) return;
    const p = settings.profiles.find((x) => x.id === id);
    const activeModel = p?.models.some((m) => m.id === settings.activeModel)
      ? settings.activeModel
      : (p?.models[0]?.id ?? MOCK_MODEL);
    onSettingsChange({ ...settings, activeProfileId: id, activeModel });
  };

  const reorder = (ids: string[]): void => {
    const byId = new Map(settings.profiles.map((p) => [p.id, p]));
    const next = ids
      .map((id) => byId.get(id))
      .filter((p): p is ProviderProfile => p !== undefined);
    if (next.length === settings.profiles.length) patchProfiles(next);
  };

  const duplicate = (id: string): void => {
    const src = settings.profiles.find((p) => p.id === id);
    if (!src) return;
    const copy: ProviderProfile = {
      ...src,
      id: newId(),
      name: `${src.name} 副本`,
      preset: false,
      models: src.models.map((m) => ({ ...m })),
    };
    const at = settings.profiles.indexOf(src) + 1;
    patchProfiles([...settings.profiles.slice(0, at), copy, ...settings.profiles.slice(at)]);
  };

  const remove = (id: string): void => {
    const next: HarnessSettings = {
      ...settings,
      profiles: settings.profiles.filter((p) => p.id !== id),
    };
    if (settings.activeProfileId === id) {
      next.activeProfileId = MOCK_PROFILE_ID;
      next.activeModel = MOCK_MODEL;
    }
    onSettingsChange(next);
  };

  const commitRename = (): void => {
    if (!renaming) return;
    const name = renaming.draft.trim();
    if (name) {
      patchProfiles(
        settings.profiles.map((p) => (p.id === renaming.id ? { ...p, name } : p)),
      );
    }
    setRenaming(null);
  };

  return (
    <div className="flex h-full min-h-0">
      <ProviderList
        profiles={settings.profiles}
        activeId={settings.activeProfileId}
        onSelect={setActive}
        onReorder={reorder}
        onRename={(id) => {
          const p = settings.profiles.find((x) => x.id === id);
          if (p) setRenaming({ id, draft: p.name });
        }}
        onDuplicate={duplicate}
        onDelete={remove}
        onAdd={() => {
          // 任务 5 接 AddProviderDialog；本任务先留空。
        }}
      />
      {/* 详情面板：未选中（或仅剩离线 mock）时保留占位。 */}
      {active ? (
        <ProviderDetail
          profile={active}
          listModels={listModels}
          onChange={patchProfile(active.id)}
          onToast={showToast}
        />
      ) : (
        <div className="grid min-w-0 flex-1 place-items-center text-sm text-(--color-app-muted)">
          选择左侧厂家
        </div>
      )}
      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-(--color-app-border) bg-(--color-app-panel) px-4 py-1.5 text-[12px] shadow-(--shadow-pop)">
          {toast}
        </div>
      )}
      {renaming && (
        <div className="fixed inset-0 z-50 grid place-items-center">
          <button
            type="button"
            aria-label="取消重命名"
            onClick={() => setRenaming(null)}
            className="fade-in absolute inset-0 bg-black/25"
          />
          <div className="relative flex w-[320px] flex-col gap-3 rounded-2xl border border-(--color-app-border) bg-(--color-app-panel) p-4 shadow-(--shadow-pop)">
            <h2 className="text-[13px] font-semibold">重命名厂家</h2>
            <input
              autoFocus
              value={renaming.draft}
              onChange={(e) => setRenaming({ ...renaming, draft: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setRenaming(null);
              }}
              aria-label="厂家名称"
              className="h-8 rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg) px-2 text-[12.5px] outline-none"
            />
            <div className="flex justify-end gap-2 text-[12px]">
              <button
                type="button"
                onClick={() => setRenaming(null)}
                className="rounded-lg border border-(--color-app-border) px-3 py-1.5"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!renaming.draft.trim()}
                onClick={commitRename}
                className="rounded-lg bg-(--color-app-accent) px-3 py-1.5 font-medium text-(--color-app-accent-fg) disabled:opacity-40"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- 通用 ------------------------------------------------------------------

function GeneralSection({
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

function AppearanceSection({
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

function AboutSection({
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

function SettingRow({
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
