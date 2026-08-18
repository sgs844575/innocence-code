import { Bolt, Minus } from "lucide-react";
import type { ModelInfo } from "../../../../../shared/ipc";
import { CapabilityTags } from "../../tags/CapabilityTags";

/** 模型行：首字母徽标 + 名称 + 能力标签 + hover 浮现的编辑/删除。 */
export function ModelRow({
  model, onEdit, onDelete,
}: {
  model: ModelInfo;
  onEdit: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  return (
    <div className="group flex min-h-[42px] items-center gap-2.5 px-4 py-1">
      <span className="grid size-[26px] shrink-0 place-items-center rounded-full border border-(--color-app-hairline) font-mono text-[10px] text-(--color-app-accent)">
        {(model.name ?? model.id).slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] select-text">{model.name ?? model.id}</span>
      <CapabilityTags model={model} />
      <button type="button" aria-label={`编辑 ${model.id}`} onClick={onEdit} className="text-(--color-app-muted) opacity-0 group-hover:opacity-100 hover:text-(--color-app-text)"><Bolt size={13} /></button>
      <button type="button" aria-label={`删除 ${model.id}`} onClick={onDelete} className="text-(--color-app-muted) opacity-0 group-hover:opacity-100 hover:text-(--color-tool-err)"><Minus size={13} /></button>
    </div>
  );
}
