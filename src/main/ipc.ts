// IPC surface — one handler per channel defined in src/shared/ipc.ts.
import { app, ipcMain } from "electron";
import { IPC, type MenuId } from "../shared/ipc";
import { TaskIpcChannels } from "../shared/taskIpc";
import { broadcastTheme, getTheme, setTheme } from "./theme";
import * as sessions from "./sessions";
import {
  getHarnessSettings,
  listProviderModels,
  pickWorkspace,
  respondPermission,
  sendChatTurn,
  setHarnessSettings,
  stopChatTurn,
  disposeSession,
} from "./harnessGlue";
import type { HarnessSettings } from "@innocencecode/harness-electron";
import { modelFromPreset, resolvePresetMeta } from "@innocencecode/harness-electron";
import { getMainWindow } from "./appWindow";
import { popupMenu } from "./menu";
import { logger } from "./logger";
import { broadcastSessions } from "./sessionEvents";
import { TaskIpcHandlers } from "./taskIpcHandlers";

/** Task IPC handlers — wired by registerTaskIpcHandlers after bridge composition. */
let taskHandlers: TaskIpcHandlers | undefined;

/**
 * Wires task IPC handlers after the TaskRuntimeBridge is created.
 * Called from the host composition root (harnessGlue / index.ts).
 */
export function registerTaskIpcHandlers(handlers: TaskIpcHandlers): void {
  taskHandlers = handlers;
}

function requireTaskHandlers(): TaskIpcHandlers {
  if (!taskHandlers) throw new Error("task bridge not wired yet");
  return taskHandlers;
}

export function registerIpcHandlers(): void {
  const needWindow = () => {
    const w = getMainWindow();
    if (!w) throw new Error("main window not ready");
    return w;
  };

  ipcMain.handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    locale: app.getLocale(),
  }));

  ipcMain.handle(IPC.themeGet, () => getTheme());
  ipcMain.handle(IPC.themeSet, (_e, mode) => {
    setTheme(mode);
    broadcastTheme(needWindow());
  });

  ipcMain.handle(IPC.sessionsList, () => sessions.listSessions());
  ipcMain.handle(IPC.sessionCreate, (_e, options?: { title?: string; workspaceRoot?: string }) => {
    const session = sessions.createSession({ title: options?.title, workspaceRoot: options?.workspaceRoot });
    broadcastSessions();
    return session;
  });
  ipcMain.handle(IPC.sessionDelete, async (_e, id: string) => {
    // Stop first, then AWAIT resource release before unlinking the session
    // index/transcript: MCP child processes are gone when the delete
    // resolves, and dispose's bounded build-wait keeps this from ever
    // hanging. The turn's final persist is NOT guaranteed to land before
    // the files disappear: dispose waits the active run, but the
    // fire-and-forget runtime.send tail (persistTurn after run settles)
    // can still write afterwards — a known, harmless orphan transcript.
    stopChatTurn(id);
    await disposeSession(id);
    sessions.deleteSession(id);
    broadcastSessions();
  });
  ipcMain.handle(IPC.messagesList, (_e, sessionId: string) => sessions.listMessages(sessionId));

  ipcMain.handle(IPC.chatSend, (_e, sessionId: string, text: string) => {
    needWindow();
    const trimmed = text.trim();
    if (!trimmed) throw new Error("empty message");
    sessions.appendMessage(sessionId, {
      id: `msg_${Date.now().toString(36)}_u`,
      role: "user",
      parts: [{ type: "text", text: trimmed }],
      createdAt: Date.now(),
    });
    // First user message retitles + reorders the session — push immediately so
    // the sidebar shows it before the stream completes.
    broadcastSessions();
    const messageId = sendChatTurn(sessionId, trimmed);
    logger.info("chat:send", { sessionId, messageId });
    return { messageId };
  });

  ipcMain.handle(IPC.chatStop, (_e, sessionId: string) => {
    stopChatTurn(sessionId);
  });

  ipcMain.handle(IPC.chatPermissionRespond, (_e, requestId: string, choice: string) => {
    if (choice === "allow" || choice === "allowSession" || choice === "deny") {
      respondPermission(requestId, choice);
    }
  });

  ipcMain.handle(IPC.workspacePick, () => pickWorkspace());

  ipcMain.handle(IPC.settingsGet, () => getHarnessSettings());
  ipcMain.handle(IPC.settingsSet, (_e, next: HarnessSettings) => setHarnessSettings(next));
  ipcMain.handle(IPC.settingsModelsList, (_e, profileId: string) => {
    const profile = getHarnessSettings().profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`profile not found: ${profileId}`);
    return listProviderModels(profile);
  });
  ipcMain.handle(IPC.settingsEnrichModels, (_e, providerName: string, ids: string[]) =>
    // 渲染层无法 import harness-electron（node 侧包），预设元数据在 main 补全。
    // 未命中预设（自定义厂家/未知型号）→ 返回最小 fetch 对象，不再误标 preset。
    ids.map((id) =>
      resolvePresetMeta(providerName, id)
        ? modelFromPreset(providerName, id)
        : { id, source: "fetch" as const },
    ),
  );

  ipcMain.handle(IPC.menuPopup, (_e, id: MenuId) => {
    popupMenu(needWindow(), id);
  });

  // -- Task review/route/complete channels (Task 7) ------------------------
  // Each handler delegates to TaskIpcHandlers which validates the calling
  // session, resolves task/route ownership, and delegates mutations to the
  // TaskCommandPort.  The handlers are wired after bridge composition.
  ipcMain.handle(TaskIpcChannels.taskGet, (_e, req) => requireTaskHandlers().getTask(req));
  ipcMain.handle(TaskIpcChannels.taskChange, (_e, req) => requireTaskHandlers().changeTask(req));
  ipcMain.handle(TaskIpcChannels.taskCheckpoint, (_e, req) => requireTaskHandlers().checkpoint(req));
  ipcMain.handle(TaskIpcChannels.taskReview, (_e, req) => requireTaskHandlers().review(req));
  ipcMain.handle(TaskIpcChannels.taskRestore, (_e, req) => requireTaskHandlers().restore(req));
  ipcMain.handle(TaskIpcChannels.taskListRoutes, (_e, req) => requireTaskHandlers().listRoutes(req));
  ipcMain.handle(TaskIpcChannels.taskSwitchRoute, (_e, req) => requireTaskHandlers().switchRoute(req));
  ipcMain.handle(TaskIpcChannels.taskForkRoute, (_e, req) => requireTaskHandlers().forkRoute(req));
  ipcMain.handle(TaskIpcChannels.taskEditUserMessage, (_e, req) => requireTaskHandlers().editUserMessage(req));
  ipcMain.handle(TaskIpcChannels.taskRetryAssistant, (_e, req) => requireTaskHandlers().retryAssistant(req));
  ipcMain.handle(TaskIpcChannels.taskComplete, (_e, req) => requireTaskHandlers().complete(req));
  ipcMain.handle(TaskIpcChannels.taskApply, (_e, req) => requireTaskHandlers().applyAccepted(req));
  ipcMain.handle(TaskIpcChannels.taskResolveConflict, (_e, req) => requireTaskHandlers().resolveConflict(req));
  ipcMain.handle(TaskIpcChannels.taskValidate, (_e, req) => requireTaskHandlers().validate(req));
  ipcMain.handle(TaskIpcChannels.taskRecoveryWarnings, (_e, req) => requireTaskHandlers().recoveryWarnings(req));
  // Recovery retry (Task 12): renderer re-runs worktree/replay recovery.
  ipcMain.handle(TaskIpcChannels.taskRecover, (_e, req) => requireTaskHandlers().recover(req));
}
