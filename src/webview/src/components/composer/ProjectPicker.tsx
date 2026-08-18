import { Check, ChevronDown, FolderOpen, Folder } from "lucide-react";
import { Popover } from "../ui/Popover";
import { projectName } from "../sidebar/groupSessions";

export interface RecentProject {
  path: string;
  /** 该项目的会话数。 */
  count: number;
}

interface Props {
  t: (key: string) => string;
  /** 当前选择："" = 不在项目中，否则为项目根目录。 */
  value: string;
  recent: RecentProject[];
  onSelect: (workspaceRoot: string) => void;
  /** 「打开项目…」——系统目录选择器（复用 pickWorkspace）。 */
  onOpenProject: () => void;
}

/** 落地态输入面板顶行的项目选择（仅新建会话时出现）：
 *  不在项目中工作 / 打开项目… / 近期聊天的项目 三选一。 */
export function ProjectPicker({ t, value, recent, onSelect, onOpenProject }: Props): React.JSX.Element {
  const label = value ? projectName(value) : t("workspace.pick");
  return (
    <Popover
      align="start"
      contentClassName="w-72 p-1"
      trigger={
        <button
          type="button"
          aria-label={t("workspace.pick")}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] text-(--color-app-muted) hover:bg-(--color-app-bubble)/60 hover:text-(--color-app-text)"
        >
          <Folder size={13} className={value ? "text-(--color-app-accent)" : ""} />
          <span className={value ? "text-(--color-app-text)" : ""}>{label}</span>
          <ChevronDown size={11} />
        </button>
      }
    >
      <PickRow selected={value === ""} title={t("project.none")} onClick={() => onSelect("")} />
      <button
        type="button"
        onClick={onOpenProject}
        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-(--color-app-muted) hover:bg-(--color-app-bubble)/60 hover:text-(--color-app-text)"
      >
        <FolderOpen size={13} />
        {t("project.open")}
      </button>
      {recent.length > 0 && (
        <>
          <div className="mx-1.5 my-1 h-px bg-(--color-app-hairline)" />
          <div className="px-2.5 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-(--color-app-muted)/70">
            {t("project.recent")}
          </div>
          {recent.map((p) => (
            <button
              key={p.path}
              type="button"
              onClick={() => onSelect(p.path)}
              className={`flex w-full flex-col items-start rounded-lg px-2.5 py-1.5 text-left hover:bg-(--color-app-bubble)/60 ${value === p.path ? "bg-(--color-app-accent-soft)" : ""}`}
            >
              <span className="flex w-full items-center gap-2 text-[12px] text-(--color-app-text)">
                <span className="truncate">{projectName(p.path)}</span>
                <span className="ml-auto shrink-0 text-[10px] text-(--color-app-muted)">
                  {t("project.sessions").replace("{n}", String(p.count))}
                </span>
                {value === p.path && <Check size={12} className="shrink-0 text-(--color-app-accent)" />}
              </span>
              <span className="w-full truncate font-mono text-[10px] text-(--color-app-muted)/70">{p.path}</span>
            </button>
          ))}
        </>
      )}
    </Popover>
  );
}

function PickRow({ selected, title, onClick }: { selected: boolean; title: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-(--color-app-bubble)/60 ${selected ? "bg-(--color-app-accent-soft) text-(--color-app-text)" : "text-(--color-app-muted)"}`}
    >
      <span className={`grid size-3.5 shrink-0 place-items-center rounded-full border ${selected ? "border-(--color-app-accent)" : "border-(--color-app-border)"}`}>
        {selected && <span className="size-1.5 rounded-full bg-(--color-app-accent)" />}
      </span>
      {title}
    </button>
  );
}
