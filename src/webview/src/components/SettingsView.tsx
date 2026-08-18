// Settings content area — renders the section picked in SettingsNav:
// models (the original platform list + detail two-pane), general
// (workspace + permission mode), appearance (theme + language), about.
import { useMemo, useState } from "react";
import {
  Search,
  Plus,
  Eye,
  EyeOff,
  RefreshCw,
  X,
  Cpu,
} from "lucide-react";
import type {
  HarnessSettings,
  PermissionMode,
  ProviderKind,
  ProviderProfile,
  ThemeMode,
} from "../../../shared/ipc";
import { api } from "../lib/ipc";
import type { SettingsSection } from "./SettingsNav";

const MOCK_ID = "__mock__";
const MOCK_NAME = "本地 Mock";

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
        <ModelsSection t={t} settings={settings} onSettingsChange={onSettingsChange} />
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

// ---- 模型服务：平台二级列表 + 详情（原有设置页主体） ------------------------

function ModelsSection({
  t,
  settings,
  onSettingsChange,
}: {
  t: (key: string) => string;
  settings: HarnessSettings;
  onSettingsChange: (next: HarnessSettings) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>(
    settings.activeProfileId === MOCK_ID ? MOCK_ID : settings.activeProfileId,
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return settings.profiles;
    return settings.profiles.filter((p) => p.name.toLowerCase().includes(q));
  }, [settings.profiles, query]);

  const selected =
    selectedId === MOCK_ID
      ? null
      : (settings.profiles.find((p) => p.id === selectedId) ?? null);

  const updateProfile = (id: string, patch: Partial<ProviderProfile>): void => {
    onSettingsChange({
      ...settings,
      profiles: settings.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  };

  const addCustomProfile = (): void => {
    const profile: ProviderProfile = {
      id: newId(),
      name: "自定义平台",
      kind: "openai",
      apiKey: "",
      baseURL: "",
      enabled: true,
      models: [],
    };
    onSettingsChange({ ...settings, profiles: [...settings.profiles, profile] });
    setSelectedId(profile.id);
  };

  return (
    <div className="flex min-h-0 flex-1 max-[900px]:flex-col">
      {/* 平台列表：宽窗为侧栏，窄窗变为顶部横向滚动行 */}
      <div className="flex w-[clamp(200px,26%,260px)] shrink-0 flex-col border-r border-(--color-app-hairline) max-[900px]:w-full max-[900px]:border-r-0 max-[900px]:border-b">
        <div className="px-3 pt-3 pb-1">
          <h2 className="px-1 text-[11px] font-semibold tracking-wider text-(--color-app-muted) uppercase">
            {t("settings.modelsService")}
          </h2>
        </div>
        <div className="px-3 pb-2 max-[900px]:pb-1">
          <div className="flex items-center gap-1.5 rounded-full bg-(--color-app-bubble) px-3 py-1.5">
            <Search size={13} className="text-(--color-app-muted)" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.searchPlatforms")}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-(--color-app-muted)"
            />
          </div>
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-2 max-[900px]:flex max-[900px]:gap-1 max-[900px]:overflow-x-auto max-[900px]:overflow-y-hidden max-[900px]:px-3 max-[900px]:py-1.5">
          <PlatformRow
            name={MOCK_NAME}
            enabled
            selected={selectedId === MOCK_ID}
            badge="M"
            onSelect={() => setSelectedId(MOCK_ID)}
          />
          {filtered.map((p) => (
            <PlatformRow
              key={p.id}
              name={p.name}
              enabled={p.enabled && p.apiKey.length > 0}
              selected={selectedId === p.id}
              badge={p.name.slice(0, 1)}
              onSelect={() => setSelectedId(p.id)}
            />
          ))}
        </div>
        <div className="border-t border-(--color-app-hairline) p-2">
          <button
            type="button"
            onClick={addCustomProfile}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-(--color-app-border) py-1.5 text-xs text-(--color-app-muted) hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
          >
            <Plus size={13} />
            {t("settings.addCustom")}
          </button>
        </div>
      </div>

      {/* 详情面板 */}
      <div className="scrollbar-thin min-w-0 flex-1 overflow-y-auto p-[clamp(14px,3vw,24px)]">
        {selected === null ? (
          <MockDetail t={t} />
        ) : (
          <ProfileDetail
            t={t}
            profile={selected}
            onChange={(patch) => updateProfile(selected.id, patch)}
          />
        )}
      </div>
    </div>
  );
}

function PlatformRow({
  name,
  enabled,
  selected,
  badge,
  onSelect,
}: {
  name: string;
  enabled: boolean;
  selected: boolean;
  badge: string;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition-colors max-[900px]:w-auto max-[900px]:shrink-0 ${
        selected ? "bg-(--color-app-accent-soft) font-medium text-(--color-app-accent)" : "hover:bg-(--color-app-bubble)"
      }`}
    >
      <span className="grid size-5 shrink-0 place-items-center rounded-md bg-(--color-app-bubble) text-[10px] font-semibold">
        {badge}
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span
        title={enabled ? "已配置" : "未配置"}
        className={`size-1.5 shrink-0 rounded-full ${enabled ? "bg-emerald-500" : "bg-transparent"}`}
      />
    </button>
  );
}

function MockDetail({ t }: { t: (key: string) => string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-(--color-app-muted)">
      <div className="card flex max-w-sm flex-col items-center gap-2 p-6">
        <Cpu size={24} />
        <p>{t("settings.mockDetail")}</p>
      </div>
    </div>
  );
}

function ProfileDetail({
  t,
  profile,
  onChange,
}: {
  t: (key: string) => string;
  profile: ProviderProfile;
  onChange: (patch: Partial<ProviderProfile>) => void;
}): React.JSX.Element {
  const [showKey, setShowKey] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [newModel, setNewModel] = useState("");

  const fetchModels = async (): Promise<void> => {
    setFetching(true);
    setFetchError("");
    try {
      const ids = await api.listProviderModels(profile.id);
      onChange({ models: [...new Set([...profile.models, ...ids])] });
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <input
          value={profile.name}
          onChange={(e) => onChange({ name: e.target.value })}
          aria-label={t("settings.platformName")}
          className="min-w-0 rounded-lg bg-transparent text-lg font-semibold outline-none hover:bg-(--color-app-bubble) focus:bg-(--color-app-bubble) focus:px-2"
        />
        <Toggle
          checked={profile.enabled}
          onChange={(enabled) => onChange({ enabled })}
          label={t("settings.enabled")}
        />
      </div>

      <h2 className="mb-2 ml-3 text-[11px] font-semibold tracking-wider text-(--color-app-muted) uppercase">
        {t("settings.apiConfig")}
      </h2>
      {/* iOS 分组卡片：一个圆角容器，组内发丝分隔线 */}
      <div className="card divide-y divide-(--color-app-hairline)">
        {!profile.preset && (
          <div className="p-3.5">
            <Field label={t("settings.kind")}>
              <select
                value={profile.kind}
                onChange={(e) => onChange({ kind: e.target.value as ProviderKind })}
                className="w-full rounded-xl border border-(--color-app-hairline) bg-(--color-app-bubble) px-3 py-2 text-sm outline-none"
              >
                <option value="openai">OpenAI 兼容协议</option>
                <option value="anthropic">Anthropic 协议</option>
              </select>
            </Field>
          </div>
        )}

        <div className="p-3.5">
          <Field label={t("settings.apiKey")}>
            <div className="flex items-center gap-2 rounded-xl border border-(--color-app-hairline) bg-(--color-app-bubble) px-3 py-2">
              <input
                type={showKey ? "text" : "password"}
                value={profile.apiKey}
                onChange={(e) => onChange({ apiKey: e.target.value })}
                placeholder="sk-..."
                autoComplete="off"
                className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={t("settings.showKey")}
                className="text-(--color-app-muted) hover:text-(--color-app-text)"
              >
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </Field>
        </div>

        <div className="p-3.5">
          <Field label={t("settings.baseURL")}>
            <input
              type="text"
              value={profile.baseURL}
              onChange={(e) => onChange({ baseURL: e.target.value })}
              placeholder={profile.kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
              className="w-full rounded-xl border border-(--color-app-hairline) bg-(--color-app-bubble) px-3 py-2 font-mono text-sm outline-none"
            />
          </Field>
        </div>
      </div>

      <h2 className="mt-5 mb-2 ml-3 text-[11px] font-semibold tracking-wider text-(--color-app-muted) uppercase">
        {t("settings.models")}
      </h2>
      <div className="mb-2 flex items-center justify-end">
        <button
          type="button"
          onClick={() => void fetchModels()}
          disabled={fetching || !profile.apiKey}
          className="flex items-center gap-1.5 rounded-full border border-(--color-app-border) px-2.5 py-1 text-xs hover:bg-(--color-app-bubble) disabled:opacity-40"
        >
          <RefreshCw size={12} className={fetching ? "animate-spin" : ""} />
          {fetching ? t("settings.fetching") : t("settings.fetchModels")}
        </button>
      </div>
      {fetchError && (
        <p className="mb-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {fetchError}
        </p>
      )}
      <div className="card divide-y divide-(--color-app-hairline)">
        {profile.models.map((m) => (
          <div key={m} className="group flex items-center gap-2 px-3.5 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs">{m}</code>
            <button
              type="button"
              aria-label={`删除模型 ${m}`}
              onClick={() => onChange({ models: profile.models.filter((x) => x !== m) })}
              className="hidden text-(--color-app-muted) hover:text-red-400 group-hover:block"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {profile.models.length === 0 && (
          <p className="px-3.5 py-4 text-center text-xs text-(--color-app-muted)">
            {t("settings.noModels")}
          </p>
        )}
        <div className="flex items-center gap-2 p-2.5">
          <input
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            placeholder={t("settings.addModelPlaceholder")}
            className="min-w-0 flex-1 rounded-lg bg-(--color-app-bubble) px-3 py-1.5 font-mono text-xs outline-none"
          />
          <button
            type="button"
            disabled={!newModel.trim()}
            onClick={() => {
              onChange({ models: [...profile.models, newModel.trim()] });
              setNewModel("");
            }}
            className="grid size-7 shrink-0 place-items-center rounded-full bg-(--color-app-accent) text-(--color-app-accent-fg) transition-transform active:scale-95 disabled:opacity-30"
            aria-label={t("settings.addModelPlaceholder")}
          >
            <Plus size={13} />
          </button>
        </div>
      </div>
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

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-(--color-app-muted)">{label}</label>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}): React.JSX.Element {
  // iOS-style switch.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[26px] w-11 shrink-0 rounded-full transition-colors ${
        checked
          ? "bg-(--color-app-accent)"
          : "border border-(--color-app-border) bg-(--color-app-bubble)"
      }`}
    >
      <span
        className={`absolute top-1/2 size-[22px] -translate-y-1/2 rounded-full bg-white shadow transition-all ${
          checked ? "left-[20px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}
