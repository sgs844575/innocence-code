import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ChatMessage,
  ChatPermissionEvent,
  HarnessSettings,
  PermissionChoice,
  Session,
} from "../../shared/ipc";
import { api } from "./lib/ipc";
import { createT } from "./lib/i18n";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";

const APP_NAME = "InnocenceCode";

export function App(): React.JSX.Element {
  const [lang, setLang] = useState("zh-CN");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [settings, setSettings] = useState<HarnessSettings | null>(null);
  const [permission, setPermission] = useState<ChatPermissionEvent | null>(null);
  const t = useMemo(() => createT(lang), [lang]);

  const refreshSessions = useCallback(async () => {
    const list = await api.listSessions();
    setSessions(list);
    return list;
  }, []);

  useEffect(() => {
    void api.getAppInfo().then((info) => setLang(info.locale));
    void refreshSessions();
    void api.getHarnessSettings().then(setSettings);
  }, [refreshSessions]);

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

  const handlePickWorkspace = useCallback(async () => {
    const dir = await api.pickWorkspace();
    if (dir) handleSettingsChange({ workspaceRoot: dir });
  }, [handleSettingsChange]);

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
          m.id === e.messageId ? { ...m, content: m.content + e.delta } : m,
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
      void refreshSessions();
    });
    const offError = api.onChatError((e) => {
      if (e.sessionId !== activeId) return;
      setStreamingId(null);
      setPermission(null);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === e.messageId
            ? { ...m, streaming: false, content: `${m.content}\n\n> ⚠️ ${e.error}` }
            : m,
        ),
      );
    });
    return () => {
      offDelta();
      offDone();
      offError();
    };
  }, [activeId, refreshSessions]);

  const handleNewSession = useCallback(async () => {
    const session = await api.createSession();
    await refreshSessions();
    setActiveId(session.id);
  }, [refreshSessions]);

  const handleDeleteSession = useCallback(async (id: string) => {
    await api.deleteSession(id);
    if (id === activeId) setActiveId(null);
    await refreshSessions();
  }, [activeId, refreshSessions]);

  const handleSend = useCallback(async (text: string) => {
    // Typing from the empty state (no session yet) creates one on demand,
    // same as picking a suggestion card in a fresh chat client.
    const sessionId = activeId ?? (await api.createSession()).id;
    if (sessionId !== activeId) {
      await refreshSessions();
      setActiveId(sessionId);
    }

    const { messageId } = await api.sendMessage(sessionId, text);
    setStreamingId(messageId);
    // Optimistic UI: user bubble immediately, assistant bubble fills via deltas.
    const optimisticUser: ChatMessage = {
      id: `${messageId}_user`,
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    const pendingAssistant: ChatMessage = {
      id: messageId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      streaming: true,
    };
    setMessages((prev) => [...prev, optimisticUser, pendingAssistant]);
  }, [activeId, refreshSessions]);

  const handleStop = useCallback(() => {
    if (activeId && streamingId) void api.stopMessage(activeId, streamingId);
  }, [activeId, streamingId]);

  // Native menu "New Session" shortcut.
  useEffect(() => {
    const off = api.onMenuNewSession(() => void handleNewSession());
    return off;
  }, [handleNewSession]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-(--color-app-bg) text-(--color-app-text)">
      <TitleBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {!sidebarCollapsed && (
          <Sidebar
            t={t}
            appName={APP_NAME}
            sessions={sessions}
            activeId={activeId}
            onSelect={setActiveId}
            onNew={handleNewSession}
            onDelete={handleDeleteSession}
          />
        )}
        <div className="min-w-0 flex-1 border-l border-(--color-app-border)">
          <ChatView
            t={t}
            appName={APP_NAME}
            messages={messages}
            streaming={streamingId !== null}
            settings={settings}
            permission={permission}
            onSettingsChange={handleSettingsChange}
            onPickWorkspace={() => void handlePickWorkspace()}
            onPermissionRespond={handlePermissionRespond}
            onSend={handleSend}
            onStop={handleStop}
          />
        </div>
      </div>
    </div>
  );
}
