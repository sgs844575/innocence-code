// Custom title bar: sidebar-toggle, disabled back/forward history stubs,
// and text File/Edit/View/Help buttons that pop up native submenus
// (see src/main/menu.ts popupMenu). This is a drag region except for the
// interactive controls, since the window is frameless.
import { PanelLeft, ChevronLeft, ChevronRight, Bell } from "lucide-react";
import { api } from "../lib/ipc";
import type { MenuId } from "../../../shared/ipc";

interface Props {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

const MENUS: { id: MenuId; label: string }[] = [
  { id: "file", label: "文件" },
  { id: "edit", label: "编辑" },
  { id: "view", label: "视图" },
  { id: "help", label: "帮助" },
];

export function TitleBar({ sidebarOpen, onToggleSidebar }: Props): React.JSX.Element {
  return (
    <header className="titlebar app-drag flex h-9 shrink-0 items-center gap-1 px-2 text-(--color-app-muted)">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? "折叠侧边栏" : "展开侧边栏"}
        aria-pressed={sidebarOpen}
        className="app-no-drag grid size-7 place-items-center rounded-full hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
      >
        <PanelLeft size={15} />
      </button>

      {/* Back/forward are stubs: this single-page app has no navigable
          history, so they stay visually present but disabled rather than
          faking a feature that does not exist. Hidden on narrow windows. */}
      <button
        type="button"
        disabled
        aria-label="后退"
        className="app-no-drag grid size-7 place-items-center rounded-full opacity-40 max-[860px]:hidden"
      >
        <ChevronLeft size={15} />
      </button>
      <button
        type="button"
        disabled
        aria-label="前进"
        className="app-no-drag grid size-7 place-items-center rounded-full opacity-40 max-[860px]:hidden"
      >
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

      <div className="flex-1" />

      <button
        type="button"
        aria-label="通知"
        className="app-no-drag grid size-7 place-items-center rounded-full hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
      >
        <Bell size={15} />
      </button>
    </header>
  );
}
