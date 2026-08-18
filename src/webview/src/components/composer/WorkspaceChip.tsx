import { Folder } from "lucide-react";
import { Popover } from "../ui/Popover";

export function WorkspaceChip({
  t, root, onPick,
}: {
  t: (key: string) => string;
  root: string;
  onPick: () => void;
}): React.JSX.Element {
  const name = root.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";
  return (
    <Popover
      contentClassName="w-72 p-3"
      trigger={
        <button type="button" title={root || t("workspace.none")} className="flex max-w-[160px] items-center gap-1 rounded-full px-2 py-1 text-[11px] hover:bg-(--color-app-bubble)">
          <Folder size={13} className="shrink-0" />
          <span className="truncate">{name || t("workspace.none")}</span>
        </button>
      }
    >
      <div className="break-all font-mono text-[10.5px] text-(--color-app-muted)">{root || t("workspace.none")}</div>
      <button type="button" onClick={onPick} className="mt-2 w-full rounded-lg border border-(--color-app-border) px-2 py-1 text-[11.5px] hover:bg-(--color-app-bubble)/60">
        {t("workspace.change")}
      </button>
    </Popover>
  );
}
