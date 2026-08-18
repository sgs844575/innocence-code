import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  MessageSquarePlus,
  PanelLeftOpen,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  appendText,
  type AppInfo,
  type ChatMessage,
  type ChatPermissionEvent,
  type HarnessSettings,
  type PermissionChoice,
  type Session,
} from "../../shared/ipc";
import { api } from "./lib/ipc";
import { createT } from "./lib/i18n";
import { useMediaQuery } from "./lib/useMediaQuery";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { SettingsView } from "./components/SettingsView";
import { SETTINGS_SECTIONS, SettingsNav, type SettingsSection } from "./components/SettingsNav";
import { NavRail } from "./components/NavRail";

const APP_NAME = "InnocenceCode";

export function App(): React.JSX.Element {
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [section, setSection] = useState<SettingsSection>("models");
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [settings, setSettings] = useState<HarnessSettings | null>(null);
  const [permission, setPermission] = useState<ChatPermissionEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Three-step responsive nav: wide windows dock the full sidebar (or a
  // manual icon rail), medium windows always show the rail plus an overlay
  // drawer, narrow windows are drawer-only.
  const isWide = useMediaQuery("(min-width: 1024px)");
  const isMedium = useMediaQuery("(min-width: 640px)") && !isWide;
  const [railMode, setRailMode] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Persisted locale wins; fall back to the system locale, then zh-CN.
  const lang = settings?.locale || appInfo?.locale || "zh-CN";
  const t = useMemo(() => createT(lang), [lang]);

  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 4000);
  }, []);

  const refreshSessions = useCallback(async () => {
    const list = await api.listSessions();
    setSessions(list);
    return list;
  }, []);

  useEffect(() => {
    void api.getAppInfo().then(setAppInfo);
    void refreshSessions();
    void api.getHarnessSettings().then(setSettings);
  }, [refreshSessions]);

  // The main process pushes the session list after every store mutation, so
  // the sidebar stays in sync no matter which path created/changed a session.
  useEffect(() => {
    const off = api.onSessionsChanged((list) => setSessions(list));
    return off;
  }, []);

  // The overlay drawer only exists below the wide breakpoint.
  useEffect(() => {
    if (isWide) setDrawerOpen(false);
  }, [isWide]);

  // Permission asks arrive mid-stream; only one card at a time (the loop
  // resolves asks sequentially).
  useEffect(() => {
    const off = api.onChatPermission((e) => {
      if (e.sessionId !== activeId) return;
      setPermission(e);
    });
    return off;
  }, [activeId]);

  const handlePermissionRespond = useCallback(
    (requestId: string, choice: PermissionChoice) => {
      setPermission(null);
      void api.respondChatPermission(requestId, choice);
    },
    [],
  );

  const handleSettingsChange = useCallback(
    (patch: Partial<HarnessSettings>) => {
      setSettings((prev) => {
        if (!prev) return prev;
        const next = { ...prev, ...patch };
        void api.setHarnessSettings(next);
        return next;
      });
    },
    [],
  );

  // 会话切换携带项目：agent 的工作区（settings.workspaceRoot）跟随所选
  // 会话的绑定项目——侧栏分组与实际执行目录永远一致。
  const handleSelectSession = useCallback(
    (id: string) => {
      setActiveId(id);
      if (!isWide) setDrawerOpen(false); // Drawer mode: selection dismisses it.
      const ws = sessions.find((s) => s.id === id)?.workspaceRoot ?? "";
      if (settings && ws !== settings.workspaceRoot) {
        handleSettingsChange({ workspaceRoot: ws });
      }
    },
    [isWide, sessions, settings, handleSettingsChange],
  );

  /** Full-settings replacement (settings page edits whole profiles). */
  const handleSettingsSet = useCallback((next: HarnessSettings) => {
    setSettings(next);
    void api.setHarnessSettings(next);
  }, []);

  const handlePickWorkspace = useCallback(async () => {
    const dir = await api.pickWorkspace();
    if (dir) handleSettingsChange({ workspaceRoot: dir });
  }, [handleSettingsChange]);

  /** 落地态「打开项目…」：结果只进选择器，不直接改全局（发送时才生效）。 */
  const handleOpenProjectDir = useCallback(async () => {
    const dir = await api.pickWorkspace();
    if (dir) setPendingProject(dir);
  }, []);

  /** 近期聊天的项目：从会话历史聚合（最近使用优先，最多 5 个）。 */
  const recentProjects = useMemo(() => {
    const byPath = new Map<string, { path: string; count: number; last: number }>();
    for (const s of sessions) {
      const p = s.workspaceRoot ?? "";
      if (!p) continue;
      const cur = byPath.get(p);
      byPath.set(p, { path: p, count: (cur?.count ?? 0) + 1, last: Math.max(cur?.last ?? 0, s.updatedAt) });
    }
    return [...byPath.values()]
      .sort((a, b) => b.last - a.last)
      .slice(0, 5)
      .map(({ path, count }) => ({ path, count }));
  }, [sessions]);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    void api.listMessages(activeId).then(setMessages);
  }, [activeId]);

  // Streaming events — apply deltas only to the active session.
  useEffect(() => {
    const offDelta = api.onChatDelta((e) => {
      if (e.sessionId !== activeId) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === e.messageId ? { ...m, parts: appendText(m.parts, e.delta) } : m,
        ),
      );
    });
    const offDone = api.onChatDone((e) => {
      if (e.sessionId !== activeId) return;
      setStreamingId(null);
      setPermission(null);
      setMessages((prev) =>
        prev.map((m) => (m.id === e.messageId ? { ...m, streaming: false } : m)),
      );
    });
    const offError = api.onChatError((e) => {
      if (e.sessionId !== activeId) return;
      setStreamingId(null);
      setPermission(null);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === e.messageId
            ? { ...m, streaming: false, parts: appendText(appendText(m.parts, "\n\n> ⚠️ "), e.error) }
            : m,
        ),
      );
    });
    // Structured tool parts arrive pre-formed (toolCall/toolResult) and append
    // as-is; thinking deltas extend the trailing thinking part or open one.
    // MessageItem renders text only for now — tasks 9-11 take over part
    // rendering; the state just has to be correct by then.
    const offTool = api.onChatTool((e) => {
      if (e.sessionId !== activeId) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === e.messageId ? { ...m, parts: [...m.parts, e.part] } : m)),
      );
    });
    const offThinking = api.onChatThinking((e) => {
      if (e.sessionId !== activeId) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== e.messageId) return m;
          const last = m.parts[m.parts.length - 1];
          if (last?.type === "thinking") {
            const parts = [...m.parts];
            parts[parts.length - 1] = { type: "thinking", text: last.text + e.delta };
            return { ...m, parts };
          }
          return { ...m, parts: [...m.parts, { type: "thinking", text: e.delta }] };
        }),
      );
    });
    return () => {
      offDelta();
      offDone();
      offError();
      offTool();
      offThinking();
    };
  }, [activeId]);

  // 落地态选中的项目："" = 不在项目中。进入落地态时默认取当前工作区。
  const [pendingProject, setPendingProject] = useState("");
  useEffect(() => {
    if (activeId === null) setPendingProject(settings?.workspaceRoot ?? "");
  }, [activeId, settings?.workspaceRoot]);

  // 新建 ≠ 创建：点「新建会话」只回到落地态（输入居中 + 项目选择），侧栏
  // 不出条目；真正的 createSession 在首条消息发送时发生（见 handleSend）。
  const handleNewSession = useCallback(() => {
    setActiveId(null);
    setMessages([]);
    setView("chat");
    if (!isWide) setDrawerOpen(false);
  }, [isWide]);

  const handleDeleteSession = useCallback(async (id: string) => {
    try {
      await api.deleteSession(id);
      if (id === activeId) setActiveId(null);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      console.error("delete session failed", err);
      showError(t("error.deleteSession"));
    }
  }, [activeId, t, showError]);

  const handleSend = useCallback(async (text: string) => {
    let sessionId = activeId;
    if (!sessionId) {
      // 落地态首条消息：此刻才创建会话，绑定所选项目并同步全局工作区
      //（runtime 的 agent 以 settings.workspaceRoot 为根）。
      const ws = pendingProject;
      try {
        if (ws !== (settings?.workspaceRoot ?? "")) {
          handleSettingsChange({ workspaceRoot: ws });
        }
        sessionId = (await api.createSession({ workspaceRoot: ws })).id;
      } catch (err) {
        console.error("create session failed", err);
        showError(t("error.createSession"));
        return;
      }
      setActiveId(sessionId);
    }

    let messageId: string;
    try {
      ({ messageId } = await api.sendMessage(sessionId, text));
    } catch (err) {
      console.error("send message failed", err);
      showError(t("error.sendMessage"));
      return;
    }
    setStreamingId(messageId);
    // Optimistic UI: user bubble immediately, assistant bubble fills via deltas.
    const optimisticUser: ChatMessage = {
      id: `${messageId}_user`,
      role: "user",
      parts: [{ type: "text", text }],
      createdAt: Date.now(),
    };
    const pendingAssistant: ChatMessage = {
      id: messageId,
      role: "assistant",
      parts: [],
      createdAt: Date.now(),
      streaming: true,
    };
    setMessages((prev) => [...prev, optimisticUser, pendingAssistant]);
  }, [activeId, pendingProject, settings?.workspaceRoot, handleSettingsChange, t, showError]);

  const handleStop = useCallback(() => {
    if (activeId && streamingId) void api.stopMessage(activeId, streamingId);
  }, [activeId, streamingId]);

  // Native menu "New Session" shortcut.
  useEffect(() => {
    const off = api.onMenuNewSession(() => void handleNewSession());
    return off;
  }, [handleNewSession]);

  const handleToggleSidebar = useCallback(() => {
    if (isWide) setRailMode((v) => !v);
    else setDrawerOpen((v) => !v);
  }, [isWide]);

  // Entering settings swaps the project sidebar for the settings menu.
  const handleOpenSettings = useCallback(() => {
    setView("settings");
    if (!isWide) setDrawerOpen(false);
  }, [isWide]);

  const handleBackToChat = useCallback(() => setView("chat"), []);

  const handleSelectSection = useCallback(
    (next: SettingsSection) => {
      setSection(next);
      if (!isWide) setDrawerOpen(false);
    },
    [isWide],
  );

  const sidebarProps = {
    t,
    appName: APP_NAME,
    sessions,
    activeId,
    onSelect: handleSelectSession,
    onNew: handleNewSession,
    onDelete: handleDeleteSession,
    onOpenSettings: handleOpenSettings,
  };

  // One nav per view, rendered in whichever shell slot is active (docked
  // column / rail / overlay drawer).
  const navFull =
    view === "settings" ? (
      <SettingsNav t={t} section={section} onSelect={handleSelectSection} onBack={handleBackToChat} />
    ) : (
      <Sidebar {...sidebarProps} />
    );

  const expandNav = useCallback(() => {
    if (isWide) setRailMode(false);
    else setDrawerOpen(true);
  }, [isWide]);

  const navRail =
    view === "settings" ? (
      <NavRail
        top={{ icon: ArrowLeft, label: t("settings.backToChat"), onClick: handleBackToChat }}
        items={SETTINGS_SECTIONS.map(({ id, icon, key }) => ({
          icon,
          label: t(key),
          onClick: () => handleSelectSection(id),
          active: section === id,
        }))}
      />
    ) : (
      <NavRail
        top={{ icon: MessageSquarePlus, label: t("sidebar.nav.newChat"), onClick: handleNewSession }}
        items={[{ icon: PanelLeftOpen, label: t("sidebar.open"), onClick: expandNav }]}
        bottom={{ icon: SettingsIcon, label: t("sidebar.settings"), onClick: handleOpenSettings }}
      />
    );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-(--color-app-bg) text-(--color-app-text)">
      <TitleBar
        sidebarOpen={isWide ? !railMode : drawerOpen}
        onToggleSidebar={handleToggleSidebar}
      />
      {/* One continuous surface: sidebar column (sidebar tone) + content
          column (panel tone), separated by hairlines only. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {isWide && !railMode && (
          <div className="w-[clamp(232px,20vw,288px)] shrink-0 border-r border-(--color-app-hairline) bg-(--color-app-sidebar)">
            {navFull}
          </div>
        )}
        {(isWide && railMode) || isMedium ? (
          <div className="w-12 shrink-0 border-r border-(--color-app-hairline) bg-(--color-app-sidebar)">
            {navRail}
          </div>
        ) : null}
        <main className="min-w-0 flex-1 overflow-hidden bg-(--color-app-panel)">
          {view === "settings" && settings ? (
            <SettingsView
              t={t}
              section={section}
              settings={settings}
              appInfo={appInfo}
              onSettingsChange={handleSettingsSet}
              onPickWorkspace={() => void handlePickWorkspace()}
            />
          ) : (
            <ChatView
              t={t}
              appName={APP_NAME}
              messages={messages}
              streaming={streamingId !== null}
              settings={settings}
              permission={permission}
              onSettingsChange={handleSettingsChange}
              onPermissionRespond={handlePermissionRespond}
              onSend={handleSend}
              onStop={handleStop}
              landing={activeId === null}
              pendingProject={pendingProject}
              onPickProject={setPendingProject}
              recentProjects={recentProjects}
              onOpenProjectDir={() => void handleOpenProjectDir()}
            />
          )}
        </main>
      </div>

      {/* Medium/narrow windows: overlay drawer with a scrim, flush against
          the left edge below the title bar. */}
      {!isWide && drawerOpen && (
        <div className="fixed inset-x-0 bottom-0 top-9 z-40">
          <button
            type="button"
            aria-label={t("sidebar.close")}
            onClick={() => setDrawerOpen(false)}
            className="fade-in absolute inset-0 bg-black/25"
          />
          <div className="drawer-in absolute bottom-0 left-0 top-0 w-[clamp(240px,72vw,300px)] border-r border-(--color-app-border) bg-(--color-app-sidebar) shadow-(--shadow-pop)">
            {navFull}
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="toast-in card-strong fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-sm"
        >
          {error}
        </div>
      )}
    </div>
  );
}
