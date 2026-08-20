// Custom title bar: sidebar-toggle, disabled back/forward history stubs,
// and text File/Edit/View/Help buttons that pop up native submenus
// (see src/main/menu.ts popupMenu). This is a drag region except for the
// interactive controls, since the window is frameless.
//
// Task 11: the workbench status cluster (project / route / Git branch — the
// branch chip hides until real git detection lands, so a null never renders
// a wrong "非 Git") plus the external-editor entry and the panel/terminal
// toggles. Labels go through the injected t (i18n keys titlebar.*).
// Strictly props-in/events-out — no data fetching here.
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FolderGit2,
  GitBranch,
  PanelLeft,
  PanelRight,
  SquareTerminal,
} from "lucide-react";
import { api } from "../lib/ipc";
import { zhCN } from "../lib/i18n";
import type { MenuId } from "../../../shared/ipc";

interface Props {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** Workbench view model; omitted cluster entirely when absent. */
  workbench?: {
    project: string;
    routeId: string | null;
    /** null → chip hidden (real Git detection lands with the task context wiring). */
    gitBranch: string | null;
  };
  onOpenExternalEditor?: () => void;
  panelOpen?: boolean;
  onTogglePanel?: () => void;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  t?: (key: string) => string;
}

const MENUS: { id: MenuId; label: string }[] = [
  { id: "file", label: "文件" },
  { id: "edit", label: "编辑" },
  { id: "view", label: "视图" },
  { id: "help", label: "帮助" },
];

const iconButton =
  "app-no-drag grid size-7 place-items-center rounded-full hover:bg-(--color-app-bubble) hover:text-(--color-app-text) disabled:opacity-40";

export function TitleBar({
  sidebarOpen,
  onToggleSidebar,
  workbench,
  onOpenExternalEditor,
  panelOpen,
  onTogglePanel,
  terminalOpen,
  onToggleTerminal,
  t = (key: string): string => zhCN[key] ?? key,
}: Props): React.JSX.Element {
  return (
    <header className="titlebar app-drag flex h-9 shrink-0 items-center gap-1 px-2 text-(--color-app-muted)">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? "折叠侧边栏" : "展开侧边栏"}
        aria-pressed={sidebarOpen}
        className={iconButton}
      >
        <PanelLeft size={15} />
      </button>

      {/* Back/forward are stubs: this single-page app has no navigable
          history, so they stay visually present but disabled rather than
          faking a feature that does not exist. Hidden on narrow windows. */}
      <button type="button" disabled aria-label="后退" className={`${iconButton} max-[860px]:hidden`}>
        <ChevronLeft size={15} />
      </button>
      <button type="button" disabled aria-label="前进" className={`${iconButton} max-[860px]:hidden`}>
        <ChevronRight size={15} />
      </button>

      <nav className="app-no-drag ml-1 flex items-center gap-0.5 text-[13px]">
        {MENUS.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => void api.popupMenu(m.id)}
            className="rounded-full px-2.5 py-1 hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
          >
            {m.label}
          </button>
        ))}
      </nav>

      {/* Workbench 状态簇：项目 / 对话路线 / Git branch（未知时整片隐藏）。 */}
      {workbench && (
        <div className="app-no-drag ml-2 hidden min-w-0 items-center gap-2 text-[11.5px] md:flex">
          {workbench.project !== "" && (
            <span className="flex min-w-0 items-center gap-1" title={`${t("titlebar.project")} ${workbench.project}`}>
              <FolderGit2 size={12} className="shrink-0" />
              <span className="max-w-[160px] truncate">{workbench.project}</span>
            </span>
          )}
          {workbench.routeId !== null && (
            <span
              className="flex shrink-0 items-center gap-1 rounded bg-(--color-app-bubble) px-1.5 py-0.5 font-mono text-[10.5px]"
              title={`${t("titlebar.route")} ${workbench.routeId}`}
            >
              <GitBranch size={10} /> {workbench.routeId}
            </span>
          )}
          {workbench.gitBranch !== null && (
            <span
              className="flex shrink-0 items-center gap-1 font-mono text-[10.5px]"
              title={workbench.gitBranch}
            >
              <GitBranch size={10} /> {workbench.gitBranch}
            </span>
          )}
        </div>
      )}

      <div className="flex-1" />

      {/* 外部编辑器入口 + 面板/终端开关（宿主未接线时禁用）。 */}
      <button
        type="button"
        aria-label={t("titlebar.externalEditor")}
        title={t("titlebar.externalEditor")}
        disabled={onOpenExternalEditor === undefined}
        onClick={onOpenExternalEditor}
        className={`${iconButton} max-[860px]:hidden`}
      >
        <ExternalLink size={14} />
      </button>
      {onTogglePanel && (
        <button
          type="button"
          aria-label={t("titlebar.togglePanel")}
          title={t("titlebar.togglePanel")}
          aria-pressed={panelOpen}
          onClick={onTogglePanel}
          className={iconButton}
        >
          <PanelRight size={14} />
        </button>
      )}
      {onToggleTerminal && (
        <button
          type="button"
          aria-label={t("titlebar.toggleTerminal")}
          title={t("titlebar.toggleTerminal")}
          aria-pressed={terminalOpen}
          onClick={onToggleTerminal}
          className={iconButton}
        >
          <SquareTerminal size={14} />
        </button>
      )}

      <button type="button" aria-label="通知" className={iconButton}>
        <Bell size={15} />
      </button>
    </header>
  );
}
