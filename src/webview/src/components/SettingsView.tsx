// Settings content area — renders the section picked in SettingsNav:
// models (cherry-style provider list + detail pane), general
// (workspace + permission mode), appearance (theme + language), about.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PROVIDER_PRESET_MIRROR,
  type HarnessSettings,
  type ModelInfo,
  type PermissionMode,
  type ProviderProfile,
  type ThemeMode,
} from "../../../shared/ipc";
import type { SettingsSection } from "./SettingsNav";
import { api } from "../lib/ipc";
import { AddProviderDialog } from "./settings/provider/AddProviderDialog";
import { EditModelDrawer } from "./settings/provider/EditModelDrawer";
import { ProviderDetail } from "./settings/provider/ProviderDetail";
import { ProviderList } from "./settings/provider/ProviderList";
import { SyncDrawer } from "./settings/provider/SyncDrawer";
import type { SyncPlan } from "./settings/provider/mergeSync";

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
  // 编辑模型抽屉的目标：null 关闭；{id:""} 为新建，首个带 id 的保存才真正落库。
  const [editing, setEditing] = useState<ModelInfo | null>(null);
  // 同步抽屉（↻ 获取模型）与添加厂家对话框的开合状态。
  const [syncOpen, setSyncOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // Map 方案：打开抽屉前预取的预设元数据（IPC enrichModels），供 mergeSync 注入。
  const [syncMap, setSyncMap] = useState<Map<string, ModelInfo>>(new Map());
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

  // useCallback 稳定引用：SyncDrawer 的拉取 effect 以其为依赖，避免 toast 等
  // 无关 state 更新触发重复拉取。
  const listModels = useCallback(
    (profile: ProviderProfile): Promise<string[]> => api.listProviderModels(profile.id),
    [],
  );

  const active = settings.profiles.find((p) => p.id === settings.activeProfileId);

  /** ↻ 获取模型：先预取模型列表 + 预设元数据（渲染层无法 import harness-electron
   *  包，经 IPC 在 main 侧补全），再打开同步抽屉。 */
  const openSync = (): void => {
    if (!active) return;
    void (async () => {
      try {
        const ids = await api.listProviderModels(active.id);
        const metas = await api.enrichModels(active.name, ids);
        setSyncMap(new Map(metas.map((m) => [m.id, m])));
        setSyncOpen(true);
      } catch (err) {
        showToast(`获取模型失败：${(err as Error).message.slice(0, 120)}`);
      }
    })();
  };

  /** mergeSync 第四参注入（Map 方案）：预取元数据按 id 查表，未命中退化为
   *  最小 fetch 对象。 */
  const syncModelFromPreset = useCallback(
    (_providerName: string, id: string): ModelInfo =>
      syncMap.get(id) ?? { id, source: "fetch" },
    [syncMap],
  );

  /** 同步抽屉回写：models = kept + added（保序合并），removed 两组皆无 → 移除。 */
  const applySyncPlan = (plan: SyncPlan): void => {
    if (!active) return;
    patchProfile(active.id)({ models: [...plan.kept, ...plan.added] });
    setSyncOpen(false);
  };

  /** 编辑抽屉回写：已有 id → 替换条目并带 dirty（enrich 不再覆盖）；新建未定 id →
   *  先累积进 editing，直到某个 patch 带 id 才作为 manual 模型插入。取消（id 仍为
   *  空）则什么都不落。 */
  const applyModelPatch = (patch: Partial<ModelInfo> & { dirty?: boolean }): void => {
    if (!active || !editing) return;
    if (!editing.id) {
      const next = { ...editing, ...patch };
      if (patch.id) {
        const inserted: ModelInfo = { ...next, source: "manual" };
        patchProfile(active.id)({ models: [...active.models, inserted] });
        setEditing(inserted); // 后续字段改走"替换条目"路径
      } else {
        setEditing(next);
      }
      return;
    }
    patchProfile(active.id)({
      models: active.models.map((m) => (m.id === editing.id ? { ...m, ...patch } : m)),
    });
  };

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
        onAdd={() => setAddOpen(true)}
      />
      {/* 详情面板：未选中（或仅剩离线 mock）时保留占位。 */}
      {active ? (
        <ProviderDetail
          profile={active}
          listModels={listModels}
          onChange={patchProfile(active.id)}
          onToast={showToast}
          onEditModel={setEditing}
          onSync={openSync}
        />
      ) : (
        <div className="grid min-w-0 flex-1 place-items-center text-sm text-(--color-app-muted)">
          选择左侧厂家
        </div>
      )}
      <EditModelDrawer
        open={editing !== null}
        model={editing}
        onClose={() => setEditing(null)}
        onSave={applyModelPatch}
      />
      {active && (
        <SyncDrawer
          open={syncOpen}
          profile={active}
          onClose={() => setSyncOpen(false)}
          listModels={listModels}
          onApply={applySyncPlan}
          modelFromPreset={syncModelFromPreset}
        />
      )}
      <AddProviderDialog
        open={addOpen}
        presets={PROVIDER_PRESET_MIRROR}
        onClose={() => setAddOpen(false)}
        onCreate={(p) => patchProfiles([...settings.profiles, p])}
      />
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
