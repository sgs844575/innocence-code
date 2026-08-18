import { useMemo, useState } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Search } from "lucide-react";
import type { ProviderProfile } from "../../../../../shared/ipc";
import { ProviderRow } from "./ProviderRow";
import { filterProviderList, type ProviderFilterMode } from "./providerFilter";

interface Props {
  profiles: ProviderProfile[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onRename: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
}

/** cherry 式厂家列表栏：搜索 + 全部/已启用 + dnd 排序 + 右键菜单 + 添加。 */
export function ProviderList({ profiles, activeId, onSelect, onReorder, onRename, onDuplicate, onDelete, onAdd }: Props): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ProviderFilterMode>("all");
  const visible = useMemo(() => filterProviderList(profiles, query, mode), [profiles, query, mode]);

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = profiles.map((p) => p.id);
    const from = ids.indexOf(String(e.active.id));
    const to = ids.indexOf(String(e.over.id));
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    onReorder(ids);
  };

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-(--color-app-hairline)">
      <div className="flex items-center gap-1.5 border-b border-(--color-app-hairline) p-2">
        <div className="flex h-8 flex-1 items-center gap-1.5 rounded-[10px] border border-(--color-app-hairline) px-2">
          <Search size={12} className="text-(--color-app-muted)" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索厂家或模型" className="w-full bg-transparent text-[12px] outline-none placeholder:text-(--color-app-muted)" />
        </div>
        <button type="button" onClick={() => setMode((m) => (m === "all" ? "enabled" : "all"))} title={mode === "all" ? "全部" : "已启用"} className="h-8 rounded-[10px] border border-(--color-app-hairline) px-2 text-[11px] text-(--color-app-muted)">
          {mode === "all" ? "全部" : "已启用"}
        </button>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-1.5">
        <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={visible.map((p) => p.id)} strategy={verticalListSortingStrategy}>
            {visible.map((p) => (
              <ProviderRow
                key={p.id}
                profile={p}
                active={p.id === activeId}
                onSelect={() => onSelect(p.id)}
                onRename={() => onRename(p.id)}
                onDuplicate={() => onDuplicate(p.id)}
                onDelete={() => onDelete(p.id)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
      <button type="button" onClick={onAdd} className="m-2 rounded-[10px] border border-dashed border-(--color-app-border) py-1.5 text-[12px] text-(--color-app-muted) hover:text-(--color-app-text)">
        ＋ 添加厂家
      </button>
    </aside>
  );
}
