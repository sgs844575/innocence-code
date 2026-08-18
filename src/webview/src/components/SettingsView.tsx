import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Search,
  Plus,
  Eye,
  EyeOff,
  RefreshCw,
  X,
  Cpu,
} from "lucide-react";
import type { HarnessSettings, ProviderKind, ProviderProfile } from "../../../shared/ipc";
import { api } from "../lib/ipc";

const MOCK_ID = "__mock__";
const MOCK_NAME = "本地 Mock";

interface Props {
  t: (key: string) => string;
  settings: HarnessSettings;
  onSettingsChange: (next: HarnessSettings) => void;
  onBack: () => void;
}

let seq = 0;
const newId = () => `custom_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export function SettingsView({ t, settings, onSettingsChange, onBack }: Props): React.JSX.Element {
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
    <div className="flex h-full min-w-0 flex-1 flex-col bg-(--color-app-bg)">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--color-app-border) bg-(--color-app-panel) px-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-(--color-app-muted) hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
        >
          <ArrowLeft size={14} />
          {t("settings.back")}
        </button>
        <span className="text-sm font-medium">{t("settings.modelsService")}</span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 平台列表 */}
        <div className="flex w-60 shrink-0 flex-col border-r border-(--color-app-border) bg-(--color-app-panel)">
          <div className="px-3 pt-3 pb-2">
            <div className="flex items-center gap-1.5 rounded-md bg-(--color-app-bubble) px-2 py-1.5">
              <Search size={13} className="text-(--color-app-muted)" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("settings.searchPlatforms")}
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-(--color-app-muted)"
              />
            </div>
          </div>
          <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-2">
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
          <div className="border-t border-(--color-app-border) p-2">
            <button
              type="button"
              onClick={addCustomProfile}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-(--color-app-border) py-1.5 text-xs text-(--color-app-muted) hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
            >
              <Plus size={13} />
              {t("settings.addCustom")}
            </button>
          </div>
        </div>

        {/* 详情面板 */}
        <div className="min-w-0 flex-1 overflow-y-auto p-5">
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
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
        selected ? "bg-(--color-app-bubble)" : "hover:bg-(--color-app-bubble)"
      }`}
    >
      <span className="grid size-5 shrink-0 place-items-center rounded bg-(--color-app-bubble) text-[10px] font-semibold">
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
      <Cpu size={24} />
      <p>{t("settings.mockDetail")}</p>
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
      <div className="mb-4 flex items-center justify-between">
        <input
          value={profile.name}
          onChange={(e) => onChange({ name: e.target.value })}
          aria-label={t("settings.platformName")}
          className="rounded-md bg-transparent text-lg font-semibold outline-none hover:bg-(--color-app-bubble) focus:bg-(--color-app-bubble) focus:px-2"
        />
        <Toggle
          checked={profile.enabled}
          onChange={(enabled) => onChange({ enabled })}
          label={t("settings.enabled")}
        />
      </div>

      {!profile.preset && (
        <Field label={t("settings.kind")}>
          <select
            value={profile.kind}
            onChange={(e) => onChange({ kind: e.target.value as ProviderKind })}
            className="w-full rounded-lg border border-(--color-app-border) bg-(--color-app-panel) px-3 py-2 text-sm outline-none"
          >
            <option value="openai">OpenAI 兼容协议</option>
            <option value="anthropic">Anthropic 协议</option>
          </select>
        </Field>
      )}

      <Field label={t("settings.apiKey")}>
        <div className="flex items-center gap-2 rounded-lg border border-(--color-app-border) bg-(--color-app-panel) px-3 py-2">
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

      <Field label={t("settings.baseURL")}>
        <input
          type="text"
          value={profile.baseURL}
          onChange={(e) => onChange({ baseURL: e.target.value })}
          placeholder={profile.kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
          className="w-full rounded-lg border border-(--color-app-border) bg-(--color-app-panel) px-3 py-2 font-mono text-sm outline-none"
        />
      </Field>

      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium">{t("settings.models")}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void fetchModels()}
              disabled={fetching || !profile.apiKey}
              className="flex items-center gap-1.5 rounded-md border border-(--color-app-border) px-2.5 py-1 text-xs hover:bg-(--color-app-bubble) disabled:opacity-40"
            >
              <RefreshCw size={12} className={fetching ? "animate-spin" : ""} />
              {fetching ? t("settings.fetching") : t("settings.fetchModels")}
            </button>
          </div>
        </div>
        {fetchError && (
          <p className="mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {fetchError}
          </p>
        )}
        <div className="space-y-1">
          {profile.models.map((m) => (
            <div
              key={m}
              className="group flex items-center gap-2 rounded-lg border border-(--color-app-border) bg-(--color-app-panel) px-3 py-1.5"
            >
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
            <p className="rounded-lg border border-dashed border-(--color-app-border) px-3 py-4 text-center text-xs text-(--color-app-muted)">
              {t("settings.noModels")}
            </p>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            placeholder={t("settings.addModelPlaceholder")}
            className="min-w-0 flex-1 rounded-lg border border-(--color-app-border) bg-(--color-app-panel) px-3 py-1.5 font-mono text-xs outline-none"
          />
          <button
            type="button"
            disabled={!newModel.trim()}
            onClick={() => {
              onChange({ models: [...profile.models, newModel.trim()] });
              setNewModel("");
            }}
            className="rounded-lg border border-(--color-app-border) px-3 py-1.5 text-xs hover:bg-(--color-app-bubble) disabled:opacity-40"
          >
            <Plus size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-4">
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
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? "bg-emerald-500" : "bg-(--color-app-bubble)"
      }`}
    >
      <span
        className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${
          checked ? "left-4.5" : "left-0.5"
        }`}
      />
    </button>
  );
}
