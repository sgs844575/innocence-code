// App — 组装层（Task 12 拆分后）。状态责任全部下沉：
//   useSessionController  会话选择/创建/删除与落地态项目
//   useChatStream         delta/tool/thinking/permission 流
//   useWorkbenchState     任务/路线/审查/冲突/恢复（纯 reducer + IPC 订阅）
//   AppShell              响应式导航与三态工作台布局
// 这里只保留跨切片的装配：settings/appInfo、语言、错误 toast、恢复横幅
// 与各面板的 props 接线。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  MessageSquarePlus,
  PanelLeftOpen,
  Settings as SettingsIcon,
} from "lucide-react";
import type { AppInfo, HarnessSettings } from "../../shared/ipc";
import { api, codeApi } from "./lib/ipc";
import { createT } from "./lib/i18n";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { SettingsView } from "./components/SettingsView";
import { SETTINGS_SECTIONS, SettingsNav } from "./components/SettingsNav";
import { NavRail } from "./components/NavRail";
import { AppShell, type AppShellNav } from "./components/AppShell";
import { RecoveryBanner } from "./components/RecoveryBanner";
import { ReviewPanel } from "./components/task/ReviewPanel";
import { RoutePanel } from "./components/task/RoutePanel";
import { CodePanel } from "./components/code/CodePanel";
import { useSessionController } from "./state/useSessionController";
import { useChatStream } from "./state/useChatStream";
import { useWorkbenchState } from "./state/useWorkbenchState";
import { restartWarningVisible, writeToolsBlocked } from "./state/workbenchState";

const APP_NAME = "InnocenceCode";

export function App(): React.JSX.Element {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState<HarnessSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shellNav = useRef<AppShellNav | null>(null);

  // Persisted locale wins; fall back to the system locale, then zh-CN.
  const lang = settings?.locale || appInfo?.locale || "zh-CN";
  const t = useMemo(() => createT(lang), [lang]);

  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 4000);
  }, []);

  useEffect(() => {
    void api.getAppInfo().then(setAppInfo);
    void api.getHarnessSettings().then(setSettings);
  }, []);

  /** 设置补丁（合并持久化 + 本地乐观更新）。 */
  const applySettingsPatch = useCallback((patch: Partial<HarnessSettings>) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      void api.setHarnessSettings(next);
      return next;
    });
  }, []);

  /** 全量设置替换（设置页整体编辑 profile）。 */
  const handleSettingsSet = useCallback((next: HarnessSettings) => {
    setSettings(next);
    void api.setHarnessSettings(next);
  }, []);

  const handlePickWorkspace = useCallback(async () => {
    const dir = await api.pickWorkspace();
    if (dir) applySettingsPatch({ workspaceRoot: dir });
  }, [applySettingsPatch]);

  const sessions = useSessionController({ settings, onSettingsChange: applySettingsPatch, showError, t });

  const workbench = useWorkbenchState({ sessionId: sessions.activeId });
  const task = workbench.state.task;

  // 恢复门禁：事件回放/worktree 失败未解决前禁止新的写回合。
  const sendGate = useCallback(
    () => (writeToolsBlocked(workbench.state) ? t("workbench.sendBlocked") : null),
    [workbench.state, t],
  );

  const chat = useChatStream({
    activeId: sessions.activeId,
    ensureSession: sessions.ensureSessionForSend,
    showError,
    t,
    sendGate,
  });

  // Native menu "New Session" shortcut — leaves settings, dismisses the
  // overlay drawer, and returns to the landing chat state.
  useEffect(() => {
    const off = api.onMenuNewSession(() => {
      shellNav.current?.backToChat();
      shellNav.current?.closeDrawerOnNavigate();
      sessions.newSession();
    });
    return off;
  }, [sessions.newSession]);

  // TitleBar 状态簇：项目取当前会话（回落全局工作区）；路线与 Git branch
  // 来自任务上下文的真实 DTO（无任务时隐藏）。
  const workspaceRoot =
    sessions.sessions.find((s) => s.id === sessions.activeId)?.workspaceRoot ??
    settings?.workspaceRoot ??
    "";
  const projectName =
    workspaceRoot === "" ? "" : (workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? "");

  // 辅助面板：审查/路线/代码以任务上下文的真实 DTO 驱动（无任务为空态）。
  const workbenchPanels = useMemo(
    () => ({
      review: (
        <ReviewPanel
          files={[]}
          taskId={task?.taskId ?? ""}
          routeId={workbench.state.activeRouteId}
          expectedVersion={task?.expectedVersion ?? ""}
          t={t}
          onReview={(dto) => void workbench.review(dto)}
          onRestore={(request) => void workbench.restore(request)}
        />
      ),
      routes: (
        <RoutePanel
          taskId={task?.taskId ?? ""}
          routes={task?.routes ?? []}
          activeRouteId={workbench.state.activeRouteId}
          t={t}
          switchRoute={workbench.switchRoute}
        />
      ),
      code: (
        <CodePanel
          taskId={task?.taskId ?? ""}
          routeId={workbench.state.activeRouteId}
          files={[]}
          t={t}
          api={codeApi}
        />
      ),
    }),
    [t, task, workbench.state.activeRouteId, workbench],
  );

  // 恢复横幅：恢复状态 → 可见告警（重试/关闭），与写工具门禁同源。
  const banner = useMemo(() => {
    const recovery = workbench.state.recovery;
    if (!restartWarningVisible(workbench.state)) return null;
    const message =
      recovery.eventRecoveryFailed !== null
        ? t("workbench.warning.eventRecovery")
        : recovery.worktreeFailure !== null
          ? t("workbench.warning.worktree")
          : recovery.checkpointFailed !== null
            ? t("workbench.warning.checkpoint")
            : recovery.recoveredFromInconsistent !== null
              ? t("workbench.warning.inconsistent")
              : t("workbench.warning.restart");
    const retryTaskId = recovery.worktreeFailure?.retry.taskId;
    return (
      <RecoveryBanner
        message={message}
        onRetry={retryTaskId !== undefined ? () => void workbench.retryRecovery(retryTaskId) : undefined}
        onDismiss={workbench.dismissRestartWarning}
        retryLabel={t("workbench.warning.retry")}
        dismissLabel={t("workbench.warning.dismiss")}
      />
    );
  }, [workbench.state, workbench.retryRecovery, workbench.dismissRestartWarning, t]);

  const sidebar = useCallback(
    (nav: AppShellNav) =>
      nav.view === "settings" ? (
        <SettingsNav t={t} section={nav.section} onSelect={nav.selectSection} onBack={nav.backToChat} />
      ) : (
        <Sidebar
          t={t}
          appName={APP_NAME}
          sessions={sessions.sessions}
          activeId={sessions.activeId}
          onSelect={(id) => {
            nav.closeDrawerOnNavigate();
            sessions.selectSession(id);
          }}
          onNew={() => {
            nav.closeDrawerOnNavigate();
            sessions.newSession();
          }}
          onDelete={(id) => void sessions.deleteSession(id)}
          onOpenSettings={nav.openSettings}
        />
      ),
    [t, sessions],
  );

  const rail = useCallback(
    (nav: AppShellNav) =>
      nav.view === "settings" ? (
        <NavRail
          top={{ icon: ArrowLeft, label: t("settings.backToChat"), onClick: nav.backToChat }}
          items={SETTINGS_SECTIONS.map(({ id, icon, key }) => ({
            icon,
            label: t(key),
            onClick: () => nav.selectSection(id),
            active: nav.section === id,
          }))}
        />
      ) : (
        <NavRail
          top={{
            icon: MessageSquarePlus,
            label: t("sidebar.nav.newChat"),
            onClick: () => {
              nav.closeDrawerOnNavigate();
              sessions.newSession();
            },
          }}
          items={[{ icon: PanelLeftOpen, label: t("sidebar.open"), onClick: nav.expandNav }]}
          bottom={{ icon: SettingsIcon, label: t("sidebar.settings"), onClick: nav.openSettings }}
        />
      ),
    [t, sessions],
  );

  const settingsView = useCallback(
    (nav: AppShellNav) =>
      settings ? (
        <SettingsView
          t={t}
          section={nav.section}
          settings={settings}
          appInfo={appInfo}
          onSettingsChange={handleSettingsSet}
          onPickWorkspace={() => void handlePickWorkspace()}
        />
      ) : null,
    [t, settings, appInfo, handleSettingsSet, handlePickWorkspace],
  );

  return (
    <AppShell
      t={t}
      bindNav={(nav) => {
        shellNav.current = nav;
      }}
      titleBar={(nav) => (
        <TitleBar
          sidebarOpen={nav.sidebarOpen}
          onToggleSidebar={nav.toggleSidebar}
          workbench={{
            project: projectName,
            routeId: task ? workbench.state.activeRouteId : null,
            gitBranch: task?.gitBranch ?? null,
          }}
          panelOpen={nav.workbench.open}
          onTogglePanel={nav.workbench.togglePanel}
          terminalOpen={nav.workbench.open && nav.workbench.tab === "terminal"}
          onToggleTerminal={nav.workbench.openTerminal}
          t={t}
        />
      )}
      sidebar={sidebar}
      rail={rail}
      banner={banner}
      toast={error}
      panels={workbenchPanels}
      chat={
        <ChatView
          t={t}
          appName={APP_NAME}
          messages={chat.messages}
          streaming={chat.streaming}
          settings={settings}
          permission={chat.permission}
          onSettingsChange={applySettingsPatch}
          onPermissionRespond={chat.respondPermission}
          onSend={(text) => void chat.send(text)}
          onStop={chat.stop}
          landing={sessions.activeId === null}
          pendingProject={sessions.pendingProject}
          onPickProject={sessions.setPendingProject}
          recentProjects={sessions.recentProjects}
          onOpenProjectDir={() => void sessions.pickProjectDir()}
        />
      }
      settings={settingsView}
    />
  );
}
