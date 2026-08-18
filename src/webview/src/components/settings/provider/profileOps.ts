// 设置 · 模型服务纯变换——从 SettingsView 的内联闭包提纯（行为不变），
// 组件只留编排；本文件不 import React / api，全部可单测。
import {
  MOCK_MODEL,
  MOCK_PROFILE_ID,
  type HarnessSettings,
  type ModelInfo,
  type ProviderProfile,
} from "../../../../../shared/ipc";
import type { SyncPlan } from "./mergeSync";

/** 拖拽排序：ids 必须恰好覆盖全部 profile（无缺漏/重复），否则返回 null 不落库。
 * dnd 调用侧（splice 重排）恒满足；Set 尺寸双检兜住重复 id 的非法输入。 */
export function reorderProfiles(
  profiles: ProviderProfile[],
  ids: string[],
): ProviderProfile[] | null {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const next = ids.map((id) => byId.get(id)).filter((p): p is ProviderProfile => p !== undefined);
  return next.length === profiles.length && new Set(ids).size === ids.length ? next : null;
}

/** 复制厂家：模型深拷贝、preset 归 false、新 id 由注入生成器给出，插在原位之后。 */
export function duplicateProfile(
  profiles: ProviderProfile[],
  id: string,
  genId: () => string,
): ProviderProfile[] | null {
  const src = profiles.find((p) => p.id === id);
  if (!src) return null;
  const copy: ProviderProfile = {
    ...src,
    id: genId(),
    name: `${src.name} 副本`,
    preset: false,
    models: src.models.map((m) => ({ ...m })),
  };
  const at = profiles.indexOf(src) + 1;
  return [...profiles.slice(0, at), copy, ...profiles.slice(at)];
}

/** 删除厂家；删的是激活厂家时聊天回落 mock（与 main 侧 mergeSettings 归一一致）。 */
export function removeProfile(settings: HarnessSettings, id: string): HarnessSettings {
  const next: HarnessSettings = {
    ...settings,
    profiles: settings.profiles.filter((p) => p.id !== id),
  };
  if (settings.activeProfileId === id) {
    next.activeProfileId = MOCK_PROFILE_ID;
    next.activeModel = MOCK_MODEL;
  }
  return next;
}

/** 编辑抽屉回写结果：models === null 表示无需写库（新建模型 id 未定，仍在草稿期）。 */
export interface ModelPatchResult {
  models: ModelInfo[] | null;
  editing: ModelInfo;
}

/** 编辑抽屉回写：新建模型首个带 id 的 patch 才以 manual 落库；已有模型 patch
 * 原位合并。返回的 editing 是抽屉的下一草稿态（新建落库后指向已插入对象，
 * 后续字段改走"替换条目"路径）。 */
export function applyModelPatch(
  models: ModelInfo[],
  editing: ModelInfo,
  patch: Partial<ModelInfo> & { dirty?: boolean },
): ModelPatchResult {
  if (!editing.id) {
    const next = { ...editing, ...patch };
    if (patch.id) {
      const inserted: ModelInfo = { ...next, source: "manual" };
      return { models: [...models, inserted], editing: inserted };
    }
    return { models: null, editing: next };
  }
  return {
    models: models.map((m) => (m.id === editing.id ? { ...m, ...patch } : m)),
    editing,
  };
}

/** 同步抽屉回写：models = kept + added（"全部添加"在调用侧把 removed 并入
 * kept、added 清空后同样走此形态，不丢任何模型）。 */
export function applySyncPlan(plan: SyncPlan): ModelInfo[] {
  return [...plan.kept, ...plan.added];
}

/** 组装 mergeSync 第四参注入：预取元数据按 id 查表，未命中退化为最小 fetch 对象。 */
export function presetModelLookup(
  metas: ModelInfo[],
): (providerName: string, id: string) => ModelInfo {
  const byId = new Map(metas.map((m) => [m.id, m]));
  return (_providerName: string, id: string): ModelInfo =>
    byId.get(id) ?? { id, source: "fetch" };
}
