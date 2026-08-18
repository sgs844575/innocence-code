// Sidebar: brand row (search/notifications), icon nav row, sessions grouped by
// project (workspaceRoot), and a footer badge. 新建会话不创建条目——只在首条
// 消息发送后由 App 建会话（落地态规则），侧栏永远只显示真实会话。
import { useMemo, useState } from "react";
import {
  ChevronDown,
  Search,
  Bell,
  MessageSquarePlus,
  Star,
  Clock,
  Puzzle,
  Settings,
} from "lucide-react";
import type { Session } from "../../../shared/ipc";
import { groupSessions, projectColor } from "./sidebar/groupSessions";

interface Props {
  t: (key: string) => string;
  appName: string;
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
}

const NAV_ITEMS = [
  { icon: MessageSquarePlus, key: "sidebar.nav.newChat" },
  { icon: Star, key: "sidebar.nav.starred" },
  { icon: Clock, key: "sidebar.nav.scheduled" },
  { icon: Puzzle, key: "sidebar.nav.plugins" },
] as const;

export function Sidebar({ t, appName, sessions, activeId, onSelect, onNew, onDelete, onOpenSettings }: Props): React.JSX.Element {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? sessions.filter((s) => s.title.toLowerCase().includes(q))
      : sessions;
    return groupSessions(filtered, t("sidebar.noProject"));
  }, [sessions, query, t]);

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        <span className="text-[15px] font-semibold">{appName}</span>
        <ChevronDown size={14} className="text-(--color-app-muted)" />
        <div className="flex-1" />
        <button
          type="button"
          aria-label={t("sidebar.search")}
          className="grid size-7 place-items-center rounded-full text-(--color-app-muted) hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
        >
          <Search size={15} />
        </button>
        <button
          type="button"
          title={t("sidebar.noNotifications")}
          className="grid size-7 place-items-center rounded-full text-(--color-app-muted) hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
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
            className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm text-(--color-app-text) hover:bg-(--color-app-bubble)"
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
          className="mb-2 w-full rounded-full border border-transparent bg-(--color-app-bubble) px-3.5 py-1.5 text-xs outline-none placeholder:text-(--color-app-muted) focus:border-(--color-app-accent)"
        />

        {groups.map((g) => (
          <section key={g.key || "__none__"} className="mb-1">
            <div className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm">
              <span className="size-[7px] shrink-0 rounded-full" style={{ background: g.key ? projectColor(g.key) : "var(--color-app-muted)" }} />
              <span className="truncate font-medium" title={g.key || undefined}>{g.name}</span>
              <span className="ml-auto text-[10px] text-(--color-app-muted)">{g.sessions.length}</span>
            </div>
            <ul className="ml-[13px] space-y-0.5 border-l border-(--color-app-border) pl-2">
              {g.sessions.map((s) => (
                <SessionRow key={s.id} session={s} active={s.id === activeId} onSelect={onSelect} onDelete={onDelete} deleteLabel={t("sidebar.delete")} />
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 && (
          <div className="px-2 py-3 text-center text-xs text-(--color-app-muted)">{t("sidebar.empty")}</div>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-(--color-app-hairline) px-3 py-2.5">
        <span className="rounded-full bg-(--color-app-bubble) px-2.5 py-1 text-[11px] font-semibold tracking-wide">
          {t("sidebar.localMode")}
        </span>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={t("sidebar.settings")}
          className="grid size-7 place-items-center rounded-full text-(--color-app-muted) hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
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
        className={`w-full truncate rounded-xl px-2 py-1.5 text-left text-sm transition-colors ${
          active
            ? "bg-(--color-app-accent-soft) font-medium text-(--color-app-accent)"
            : "hover:bg-(--color-app-bubble)"
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
