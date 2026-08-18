// Sidebar: brand row (search/notifications), icon nav row, a single project
// folder holding the session list (this app has one workspace, so one real
// folder beats fabricating fake projects), and a footer badge.
import { useMemo, useState } from "react";
import {
  ChevronDown,
  Search,
  Bell,
  MessageSquarePlus,
  Star,
  Clock,
  Puzzle,
  Folder,
  FolderOpen,
  Settings,
} from "lucide-react";
import type { Session } from "../../../shared/ipc";

interface Props {
  t: (key: string) => string;
  appName: string;
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

const NAV_ITEMS = [
  { icon: MessageSquarePlus, key: "sidebar.nav.newChat" },
  { icon: Star, key: "sidebar.nav.starred" },
  { icon: Clock, key: "sidebar.nav.scheduled" },
  { icon: Puzzle, key: "sidebar.nav.plugins" },
] as const;

export function Sidebar({ t, appName, sessions, activeId, onSelect, onNew, onDelete }: Props): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [projectOpen, setProjectOpen] = useState(true);

  const filtered = useMemo(() => {
    if (!query.trim()) return sessions;
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, query]);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col bg-(--color-app-panel)">
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        <span className="text-[15px] font-semibold">{appName}</span>
        <ChevronDown size={14} className="text-(--color-app-muted)" />
        <div className="flex-1" />
        <button
          type="button"
          aria-label={t("sidebar.search")}
          className="grid size-7 place-items-center rounded-md text-(--color-app-muted) hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
        >
          <Search size={15} />
        </button>
        <button
          type="button"
          title={t("sidebar.noNotifications")}
          className="grid size-7 place-items-center rounded-md text-(--color-app-muted) hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
        >
          <Bell size={15} />
        </button>
      </div>

      <nav className="flex flex-col gap-0.5 px-2 pb-3">
        {NAV_ITEMS.map(({ icon: Icon, key }, i) => (
          <button
            key={key}
            type="button"
            onClick={i === 0 ? onNew : undefined}
            title={i === 0 ? undefined : t("sidebar.comingSoon")}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-(--color-app-text) hover:bg-(--color-app-bubble)"
          >
            <Icon size={16} className="text-(--color-app-muted)" />
            {t(key)}
          </button>
        ))}
      </nav>

      <div className="scrollbar-thin flex-1 overflow-y-auto px-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("sidebar.filter")}
          className="mb-2 w-full rounded-md border border-transparent bg-(--color-app-bubble) px-2 py-1 text-xs outline-none placeholder:text-(--color-app-muted) focus:border-(--color-app-accent)"
        />

        <section>
          <button
            type="button"
            onClick={() => setProjectOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm font-medium hover:bg-(--color-app-bubble)"
          >
            <span className="text-[11px] font-semibold uppercase tracking-wide text-(--color-app-muted)">
              {t("sidebar.projects")}
            </span>
          </button>
          <div className="ml-1">
            <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm">
              {projectOpen ? (
                <FolderOpen size={15} className="shrink-0 text-(--color-app-muted)" />
              ) : (
                <Folder size={15} className="shrink-0 text-(--color-app-muted)" />
              )}
              <span className="truncate font-medium">{appName}</span>
            </div>
            {projectOpen && (
              <ul className="ml-3 space-y-0.5 border-l border-(--color-app-border) pl-2">
                {filtered.map((s) => (
                  <SessionRow key={s.id} session={s} active={s.id === activeId} onSelect={onSelect} onDelete={onDelete} deleteLabel={t("sidebar.delete")} />
                ))}
                {filtered.length === 0 && (
                  <li className="px-2 py-3 text-center text-xs text-(--color-app-muted)">{t("sidebar.empty")}</li>
                )}
              </ul>
            )}
          </div>
        </section>
      </div>

      <footer className="flex items-center justify-between border-t border-(--color-app-border) px-3 py-2.5">
        <span className="rounded-full bg-(--color-app-bubble) px-2.5 py-1 text-[11px] font-semibold tracking-wide">
          {t("sidebar.localMode")}
        </span>
        <button
          type="button"
          aria-label={t("sidebar.settings")}
          className="grid size-7 place-items-center rounded-md text-(--color-app-muted) hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
        >
          <Settings size={15} />
        </button>
      </footer>
    </aside>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
  onDelete,
  deleteLabel,
}: {
  session: Session;
  active: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  deleteLabel: string;
}): React.JSX.Element {
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        title={session.title}
        className={`w-full truncate rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
          active ? "bg-(--color-app-bubble)" : "hover:bg-(--color-app-bubble)"
        }`}
      >
        {session.title}
      </button>
      <button
        type="button"
        aria-label={deleteLabel}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(session.id);
        }}
        className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded px-1 text-xs text-(--color-app-muted) hover:text-(--color-app-text) group-hover:block"
      >
        ✕
      </button>
    </li>
  );
}
