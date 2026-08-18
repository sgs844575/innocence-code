// 设置 · 模型服务整页（cherry 克隆）：厂家列表栏 + 详情面板 + 全部浮层
// （编辑模型抽屉 / 获取模型同步抽屉 / 添加厂家对话框 / 重命名弹层 / 轻提示）。
// 从 SettingsView 原样迁入（行为不变），变换细节提纯在 profileOps。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MOCK_MODEL,
  PROVIDER_PRESET_MIRROR,
  type HarnessSettings,
  type ModelInfo,
  type ProviderProfile,
} from "../../../../../shared/ipc";
import { api } from "../../../lib/ipc";
import { AddProviderDialog } from "./AddProviderDialog";
import { EditModelDrawer } from "./EditModelDrawer";
import { ProviderDetail } from "./ProviderDetail";
import { ProviderList } from "./ProviderList";
import { SyncDrawer } from "./SyncDrawer";
import type { SyncPlan } from "./mergeSync";
import {
  applyModelPatch,
  applySyncPlan,
  duplicateProfile,
  presetModelLookup,
  removeProfile,
  reorderProfiles,
} from "./profileOps";

let seq = 0;
const newId = () => `custom_${Date.now().toString(36)}_${(seq++).toString(36)}`;

interface Props {
  settings: HarnessSettings;
  onSettingsChange: (next: HarnessSettings) => void;
}

export function ProviderSettingsPage({
  settings,
  onSettingsChange,
}: Props): React.JSX.Element {
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
   *  最小 fetch 对象（查表逻辑提纯在 profileOps.presetModelLookup）。 */
  const syncModelFromPreset = useMemo(
    () => presetModelLookup([...syncMap.values()]),
    [syncMap],
  );

  /** 同步抽屉回写：models = kept + added（保序合并），removed 两组皆无 → 移除。 */
  const applyPlan = (plan: SyncPlan): void => {
    if (!active) return;
    patchProfile(active.id)({ models: applySyncPlan(plan) });
    setSyncOpen(false);
  };

  /** 编辑抽屉回写：已有 id → 替换条目并带 dirty（enrich 不再覆盖）；新建未定 id →
   *  先累积进 editing，直到某个 patch 带 id 才作为 manual 模型插入。取消（id 仍为
   *  空）则什么都不落。纯变换见 profileOps.applyModelPatch。 */
  const onModelPatch = (patch: Partial<ModelInfo> & { dirty?: boolean }): void => {
    if (!active || !editing) return;
    const result = applyModelPatch(active.models, editing, patch);
    if (result.models) patchProfile(active.id)({ models: result.models });
    setEditing(result.editing);
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
    const next = reorderProfiles(settings.profiles, ids);
    if (next) patchProfiles(next);
  };

  const duplicate = (id: string): void => {
    const next = duplicateProfile(settings.profiles, id, newId);
    if (next) patchProfiles(next);
  };

  const remove = (id: string): void => {
    onSettingsChange(removeProfile(settings, id));
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
        onSave={onModelPatch}
      />
      {active && (
        <SyncDrawer
          open={syncOpen}
          profile={active}
          onClose={() => setSyncOpen(false)}
          listModels={listModels}
          onApply={applyPlan}
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
