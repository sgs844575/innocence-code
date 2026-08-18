// 预设目录 ∪ API 拉回 与本地模型的合并预览（cherry 同步抽屉的纯逻辑核）。
import type { ModelInfo } from "../../../../../shared/ipc";
import { fillModelGaps } from "./profileOps";

export interface SyncPlan {
  added: ModelInfo[];
  removed: ModelInfo[];
  kept: ModelInfo[];
}

/** 前端无法直接 import harness-electron 包，modelFromPreset 以注入方式传入
 *  （SettingsView 经 IPC 预取元数据后按 Map 包装，见任务 5 总装）。 */
export function mergeSync(
  local: ModelInfo[],
  fetched: string[],
  providerName: string,
  modelFromPreset: (providerName: string, id: string) => ModelInfo,
): SyncPlan {
  const fetchedSet = new Set(fetched);
  const added: ModelInfo[] = [];
  const removed: ModelInfo[] = [];
  const kept: ModelInfo[] = [];
  for (const m of local) {
    // 用户手改过的模型不当"失效"清理：交集或 dirty 都归 kept，
    // 否则"应用全部变更"（models = kept + added）会把它静默删掉。
    if (fetchedSet.has(m.id) || m.dirty) {
      // 规格 §4.4 逐字段 enrich：非 dirty 的 kept 用预设元数据填空缺字段
      // （仅填空不覆盖；dirty 完全不动）。未命中预设时 meta 为最小 fetch
      // 对象，无可填字段，等价原样保留。
      kept.push(m.dirty ? m : fillModelGaps(m, modelFromPreset(providerName, m.id)));
    } else removed.push(m);
  }
  const localIds = new Set(local.map((m) => m.id));
  for (const id of fetched) {
    if (!localIds.has(id)) added.push(modelFromPreset(providerName, id));
  }
  return { added, removed, kept };
}
