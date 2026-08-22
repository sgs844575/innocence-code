// App — 组装层（Task 12 拆分后）。状态责任全部下沉：
//   useSessionController  会话选择/创建/删除与落地态项目
//   useChatStream         delta/tool/thinking/permission 流
//   useWorkbenchState     任务/路线/审查/冲突/恢复（纯 reducer + IPC 订阅）
//   AppShell              响应式导航与三态工作台布局
// 这里只保留跨切片的装配：settings/appInfo、语言、错误 toast、恢复横幅
// 与各面板的 props 接线。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MessageSquarePlus,
  PanelLeftOpen,
  Settings as SettingsIcon,
} from "lucide-react";
import type { AppInfo, HarnessSettings, PluginInventory } from "../../shared/ipc";
import type { TaskForkRouteRequest } from "../../shared/taskIpc";
import { api, codeApi, taskApi, terminalApi } from "./lib/ipc";
import { createT } from "./lib/i18n";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { SettingsView } from "./components/SettingsView";
import { SettingsNav, SettingsRail } from "./components/SettingsNav";
import { NavRail } from "./components/NavRail";
import { AppShell, type AppShellNav } from "./components/AppShell";
import { RecoveryBanner } from "./components/RecoveryBanner";
import { BuiltinToolcards } from "./components/chat/toolcards/builtinToolcards";
import { BuiltinPanels } from "./components/workbench/builtinPanels";
import { BuiltinSettingsSections } from "./components/settings/builtinSettingsSections";
import { SlotProvider } from "./slots/react";
import { createSlotRegistry } from "./slots/registry";
import { importSchemeModule, loadPluginClients } from "./pluginClient/loader";
import { ReviewPanel } from "./components/task/ReviewPanel";
import { RoutePanel } from "./components/task/RoutePanel";
import { ForkRouteDialog } from "./components/task/ForkRouteDialog";
import { CodePanel } from "./components/code/CodePanel";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import type { ForkMessageCommand, TaskChangeCardCommand } from "./components/MessageItem";
import { groupHunksByFile, summarizeChanges } from "./components/task/taskViewModel";
import { useSessionController } from "./state/useSessionController";
import { useChatStream } from "./state/useChatStream";
import { useWorkbenchState } from "./state/useWorkbenchState";
import { useTaskReviewData } from "./state/useTaskReviewData";
import { restartWarningVisible, writeToolsBlocked } from "./state/workbenchState";

const APP_NAME = "InnocenceCode";

export function App(): React.JSX.Element {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState<HarnessSettings | null>(null);
  const [pluginInventory, setPluginInventory] = useState<PluginInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shellNav = useRef<AppShellNav | null>(null);
  // 槽位注册表（App 持有）：视图钩子经 <SlotProvider registry> 消费；插件
  // client 装载器（命令式、非视图层）经同一实例注册工具卡（订阅通道重渲染）。
  const [slotRegistry] = useState(createSlotRegistry);

  // Persisted locale wins; fall back to the system locale, then zh-CN.
  const lang = settings?.locale || appInfo?.locale || "zh-CN";
  const t = useMemo(() => createT(lang), [lang]);

  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 4000);
  }, []);

  /** 插件清单投影：main 按当前 toggles 现算，失败保持未返回态（骨架）。
   *  成功后装载插件渲染层 client 模块（active+client 条目经协议动态导入，
   *  同一注册表重装载先撤销旧注册；单插件失败仅告警不阻断）。 */
  const refreshPluginInventory = useCallback(() => {
    void api.getPluginInventory().then((inventory) => {
      setPluginInventory(inventory);
      void loadPluginClients({ inventory, registry: slotRegistry, importModule: importSchemeModule });
    }, () => {});
  }, [slotRegistry]);

  useEffect(() => {
    void api.getAppInfo().then(setAppInfo);
    void api.getHarnessSettings().then(setSettings);
    refreshPluginInventory();
  }, [refreshPluginInventory]);

  /** 设置补丁（合并持久化 + 本地乐观更新）。 */
  const applySettingsPatch = useCallback((patch: Partial<HarnessSettings>) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      void api.setHarnessSettings(next);
      return next;
    });
    refreshPluginInventory();
  }, [refreshPluginInventory]);

  /** 全量设置替换（设置页整体编辑 profile）。 */
  const handleSettingsSet = useCallback((next: HarnessSettings) => {
    setSettings(next);
    void api.setHarnessSettings(next);
    refreshPluginInventory();
  }, [refreshPluginInventory]);

  const handlePickWorkspace = useCallback(async () => {
    const dir = await api.pickWorkspace();
    if (dir) applySettingsPatch({ workspaceRoot: dir });
  }, [applySettingsPatch]);

  const sessions = useSessionController({ settings, onSettingsChange: applySettingsPatch, showError, t });

  const workbench = useWorkbenchState({ sessionId: sessions.activeId });
  const task = workbench.state.task;

  // 会话激活 → 探测该会话的任务并装载工作台（create=false：仅打开会话不
  // 新建任务；任务在首条消息发送时创建，见 useChatStream.ensureTask）。
  useEffect(() => {
    if (sessions.activeId !== null) void workbench.ensureTask(sessions.activeId, false);
  }, [sessions.activeId, workbench.ensureTask]);

  // 恢复门禁：事件回放/worktree 失败未解决前禁止新的写回合。
  const sendGate = useCallback(
    () => (writeToolsBlocked(workbench.state) ? t("workbench.sendBlocked") : null),
    [workbench.state, t],
  );

  // 审查面数据源（C3）：task:changes 状态化 hunks + code:list-files 文件树。
  const reviewData = useTaskReviewData({
    taskId: task?.taskId ?? "",
    routeId: workbench.state.activeRouteId,
  });
  const reviewFiles = useMemo(() => groupHunksByFile(reviewData.hunks), [reviewData.hunks]);

  // 审查/回写命令完成后对账审查面（状态化 hunk 状态随之刷新）。
  const reviewAndRefresh = useCallback(
    async (dto: Parameters<typeof workbench.review>[0]) => {
      await workbench.review(dto);
      await reviewData.refresh();
    },
    [workbench.review, reviewData],
  );
  const restoreAndRefresh = useCallback(
    async (request: Parameters<typeof workbench.restore>[0]) => {
      await workbench.restore(request);
      await reviewData.refresh();
    },
    [workbench.restore, reviewData],
  );

  const openReviewPanel = useCallback(() => {
    shellNav.current?.workbench.setTab("review");
    shellNav.current?.workbench.setOpen(true);
  }, []);

  // 分叉入口（C3）：消息操作 → ForkRouteDialog → task:fork-route；创建成功
  // 后切换路线并把分叉 prompt 发到新路线（send 走 main 侧会话绑定）。
  const [forkDialog, setForkDialog] = useState<{ request: TaskForkRouteRequest; checkpointId: string } | null>(null);
  const handleForkMessage = useCallback(
    (command: ForkMessageCommand) => {
      if (!task) return;
      const sourceRouteId = workbench.state.activeRouteId;
      setForkDialog({
        request: {
          sessionId: task.sessionId,
          taskId: task.taskId,
          sourceRouteId,
          sourceTurnId: command.turnId,
          mode: command.mode,
          ...(command.mode === "edit-user" ? { editedText: command.text } : {}),
          routeName: command.mode === "edit-user" ? `Edit ${command.turnId}` : `Retry ${command.turnId}`,
        },
        checkpointId: task.routes.find((route) => route.routeId === sourceRouteId)?.checkpointId ?? "",
      });
    },
    [task, workbench.state.activeRouteId],
  );

  const chat = useChatStream({
    activeId: sessions.activeId,
    ensureSession: sessions.ensureSessionForSend,
    ensureTask: workbench.ensureTask,
    showError,
    t,
    sendGate,
  });

  // 消息内变更卡（C3）：任务的变更摘要挂在最后一条助手消息上；点击
  // 「审查」打开工作台审查页签。
  const taskChanges = useMemo<Record<string, TaskChangeCardCommand> | undefined>(() => {
    const lastAssistant = [...chat.messages].reverse().find((m) => m.role === "assistant");
    if (!task || !lastAssistant || reviewData.hunks.length === 0) return undefined;
    const checkpointId =
      task.routes.find((route) => route.routeId === workbench.state.activeRouteId)?.checkpointId ?? "";
    return {
      [lastAssistant.id]: {
        summary: summarizeChanges(reviewData.hunks),
        checkpointId,
        validation: null,
      },
    };
  }, [task, chat.messages, reviewData.hunks, workbench.state.activeRouteId]);

  const handleForkSwitched = useCallback(
    async (routeId: string, prompt: string) => {
      if (!task) return;
      await workbench.switchRoute({ taskId: task.taskId, routeId });
      await reviewData.refresh();
      await chat.send(prompt);
    },
    [task, workbench, reviewData, chat],
  );

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
          files={reviewFiles}
          taskId={task?.taskId ?? ""}
          routeId={workbench.state.activeRouteId}
          expectedVersion={task?.expectedVersion ?? ""}
          t={t}
          onReview={(dto) => void reviewAndRefresh(dto)}
          onRestore={(request) => void restoreAndRefresh(request)}
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
          files={reviewData.files}
          t={t}
          api={codeApi}
        />
      ),
      // 终端（C2）：真实 preload 桥 + 活动任务路线；面板关闭即卸载
      // （WorkbenchShell 常驻挂载仅在面板打开期间成立）。
      terminal: (
        <TerminalPanel api={terminalApi} activeTask={workbench.activeTask} />
      ),
    }),
    [t, task, workbench.state.activeRouteId, reviewFiles, reviewData.files, reviewAndRefresh, restoreAndRefresh, workbench.switchRoute, workbench.activeTask],
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
        <SettingsRail t={t} section={nav.section} onSelect={nav.selectSection} onBack={nav.backToChat} />
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
    <SlotProvider registry={slotRegistry}>
      {/* 槽位宿主：内置工具卡/工作台面板/设置分区各注册一次，供全树经槽位消费 */}
      <BuiltinToolcards />
      <BuiltinPanels panels={workbenchPanels} />
      <BuiltinSettingsSections
        deps={{
          t,
          settings,
          appInfo,
          onSettingsChange: handleSettingsSet,
          onPickWorkspace: () => void handlePickWorkspace(),
          pluginInventory,
        }}
      />
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
            taskChanges={taskChanges}
            onOpenTaskReview={openReviewPanel}
            onForkMessage={handleForkMessage}
          />
        }
        settings={settingsView}
      />
      {forkDialog && (
        <ForkRouteDialog
          open
          request={forkDialog.request}
          checkpointId={forkDialog.checkpointId}
          onClose={() => setForkDialog(null)}
          createRoute={(request) => taskApi.forkRoute(request)}
          onSwitchRoute={(routeId, prompt) => void handleForkSwitched(routeId, prompt)}
        />
      )}
    </SlotProvider>
  );
}
