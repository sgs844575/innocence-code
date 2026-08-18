import { GripVertical, MoreVertical, Pencil, Copy, Trash2 } from "lucide-react";
import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ProviderProfile } from "../../../../../shared/ipc";

interface Props {
  profile: ProviderProfile;
  active: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function ProviderRow({ profile, active, onSelect, onRename, onDuplicate, onDelete }: Props): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: profile.id });
  const [menu, setMenu] = useState(false);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group flex h-9 items-center gap-2 rounded-[10px] px-2 ${active ? "bg-(--color-app-accent-soft)" : "hover:bg-(--color-app-bubble)/50"}`}
    >
      <button type="button" {...attributes} {...listeners} aria-label="拖动排序" className="cursor-grab text-(--color-app-muted) opacity-0 group-hover:opacity-100">
        <GripVertical size={13} />
      </button>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className="grid size-[26px] shrink-0 place-items-center rounded-full border border-(--color-app-hairline) text-[11px] font-semibold text-(--color-app-accent)">
          {profile.name.slice(0, 1)}
        </span>
        <span className="truncate text-[12.5px]">{profile.name}</span>
        {profile.preset && <span className="shrink-0 rounded-full border border-(--color-app-hairline) px-1 text-[9px] text-(--color-app-muted)">预设</span>}
      </button>
      {profile.enabled && <span className="size-1.5 shrink-0 rounded-full bg-(--color-tool-ok) group-hover:invisible" />}
      <div className="relative shrink-0">
        <button type="button" aria-label="更多操作" onClick={() => setMenu((v) => !v)} className="text-(--color-app-muted) opacity-0 group-hover:opacity-100">
          <MoreVertical size={13} />
        </button>
        {menu && (
          <div className="absolute right-0 top-6 z-20 w-28 rounded-lg border border-(--color-app-border) bg-(--color-app-panel) py-1 text-[12px] shadow-(--shadow-pop)">
            <button type="button" onClick={() => { setMenu(false); onRename(); }} className="flex w-full items-center gap-2 px-2.5 py-1 hover:bg-(--color-app-bubble)/50"><Pencil size={12} />重命名</button>
            <button type="button" onClick={() => { setMenu(false); onDuplicate(); }} className="flex w-full items-center gap-2 px-2.5 py-1 hover:bg-(--color-app-bubble)/50"><Copy size={12} />复制</button>
            <button type="button" onClick={() => { setMenu(false); onDelete(); }} className="flex w-full items-center gap-2 px-2.5 py-1 text-(--color-tool-err) hover:bg-(--color-app-bubble)/50"><Trash2 size={12} />删除</button>
          </div>
        )}
      </div>
    </div>
  );
}
