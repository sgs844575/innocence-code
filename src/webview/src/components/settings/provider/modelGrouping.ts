import type { ModelInfo } from "../../../../../shared/ipc";

/** 分组兜底名：无 group / 空白 group 的模型统一落这里。 */
export const UNGROUPED = "未分组";

/** 按模型首次出现顺序分组；group 空白（含 trim 后为空）落『未分组』。 */
export function groupModels(models: ModelInfo[]): [string, ModelInfo[]][] {
  const map = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const key = m.group?.trim() || UNGROUPED;
    const list = map.get(key) ?? [];
    list.push(m);
    map.set(key, list);
  }
  return [...map.entries()];
}

export type CapabilityTab = "all" | "vision" | "tools" | "reasoning";

/** 能力筛选谓词（严格 === true，与 CapabilityTags 的显示条件一致）。 */
export const modelGroupName = {
  tabVision: (m: ModelInfo): boolean => m.vision === true,
  tabTools: (m: ModelInfo): boolean => m.tools === true,
  tabReasoning: (m: ModelInfo): boolean => m.reasoning === true,
} as const;
