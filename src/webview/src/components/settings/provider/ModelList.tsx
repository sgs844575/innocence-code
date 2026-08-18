import { useMemo, useState } from "react";
import { ChevronRight, Plus, RefreshCw, Search } from "lucide-react";
import type { ModelInfo, ProviderProfile } from "../../../../../shared/ipc";
import { ModelRow } from "./ModelRow";
import { groupModels, modelGroupName, type CapabilityTab } from "./modelGrouping";

interface Props {
  profile: ProviderProfile;
  onChange: (patch: Partial<ProviderProfile>) => void;
  /** 契约保留（ProviderDetail 透传）；获取模型的实际入口走 onSync（任务 5 接线）。 */
  listModels: (profile: ProviderProfile) => Promise<string[]>;
  onToast: (msg: string) => void;
  /** 编辑抽屉的回写通道（任务 4 由 SettingsView 接入）。 */
  onPatchModel?: (modelId: string, patch: Partial<ModelInfo>) => void;
  /** 打开编辑抽屉（任务 4 接线；undefined 时按钮仍渲染但点击无操作）。 */
  onEditModel?: (model: ModelInfo) => void;
  /** 打开同步抽屉（任务 5 接线；未提供时不渲染 ↻ 按钮）。 */
  onSync?: () => void;
}

const TAB_PREDICATE: Record<Exclude<CapabilityTab, "all">, (m: ModelInfo) => boolean> = {
  vision: modelGroupName.tabVision,
  tools: modelGroupName.tabTools,
  reasoning: modelGroupName.tabReasoning,
};

/** 模型列表：分组折叠卡 + 行内搜索 + 能力筛选 tab；编辑/删除走行内按钮。 */
export function ModelList({ profile, onChange, onEditModel, onSync }: Props): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<CapabilityTab>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return profile.models.filter((m) => {
      if (tab !== "all" && !TAB_PREDICATE[tab](m)) return false;
      if (q && !m.id.toLowerCase().includes(q) && !(m.name ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [profile.models, query, tab]);
  const groups = groupModels(filtered);

  const deleteModel = (id: string) =>
    onChange({ models: profile.models.filter((m) => m.id !== id) });

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] font-semibold">模型列表</h2>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex h-7 items-center gap-1 rounded-lg border border-(--color-app-hairline) px-1.5">
            <Search size={11} className="text-(--color-app-muted)" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索" className="w-28 bg-transparent text-[11.5px] outline-none" />
          </div>
          <button type="button" onClick={() => setTab("all")} className={tabCls(tab, "all")}>全部</button>
          <button type="button" onClick={() => setTab("vision")} className={tabCls(tab, "vision")}>👁</button>
          <button type="button" onClick={() => setTab("tools")} className={tabCls(tab, "tools")}>🔧</button>
          <button type="button" onClick={() => setTab("reasoning")} className={tabCls(tab, "reasoning")}>🧠</button>
          {onSync && (
            <button type="button" aria-label="获取模型" title="获取模型" onClick={onSync} className="grid size-7 place-items-center rounded-lg border border-(--color-app-hairline) text-(--color-app-muted) hover:text-(--color-app-text)">
              <RefreshCw size={13} />
            </button>
          )}
          <button type="button" aria-label="添加模型" title="添加模型" onClick={() => onEditModel?.({ id: "", source: "manual" })} className="grid size-7 place-items-center rounded-lg border border-(--color-app-hairline) text-(--color-app-muted) hover:text-(--color-app-text)">
            <Plus size={13} />
          </button>
        </div>
      </div>
      {groups.map(([name, models]) => {
        const open = !collapsed.has(name);
        return (
          <div key={name} className="overflow-hidden rounded-lg border border-(--color-app-hairline)">
            <button type="button" onClick={() => setCollapsed((prev) => toggle(prev, name))} className="flex w-full items-center gap-2 bg-(--color-app-bubble)/30 px-3 py-1.5 text-left text-[12px]">
              <ChevronRight size={13} className={`transition-transform ${open ? "rotate-90" : ""}`} />
              <span>{name}</span>
              <span className="text-[10.5px] text-(--color-app-muted)">{models.length}</span>
            </button>
            {open && models.map((m) => (
              <ModelRow key={m.id} model={m} onEdit={() => onEditModel?.(m)} onDelete={() => deleteModel(m.id)} />
            ))}
          </div>
        );
      })}
      {profile.models.length === 0 && (
        <div className="rounded-lg border border-dashed border-(--color-app-border) py-6 text-center text-[12px] text-(--color-app-muted)">暂无模型——点右上 ↻ 获取，或 ＋ 手动添加</div>
      )}
    </section>
  );
}

const tabCls = (cur: CapabilityTab, mine: CapabilityTab): string =>
  cur === mine ? "bg-(--color-app-accent-soft) text-(--color-app-accent)" : "";
function toggle(prev: Set<string>, name: string): Set<string> {
  const next = new Set(prev);
  if (next.has(name)) next.delete(name); else next.add(name);
  return next;
}
