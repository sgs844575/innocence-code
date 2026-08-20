// Preload — the only bridge between the sandboxed renderer and the main
// process. Exposes a minimal, typed API surface (contextBridge) with
// sandbox + contextIsolation and no Node in the renderer.
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type InnocenceCodeApi, type ThemeMode } from "../shared/ipc";
import {
  TaskIpcChannels,
  type TaskIpcApi,
  type TaskUiEvent,
  type TaskUiNotice,
} from "../shared/taskIpc";
import {
  CodeIpcChannels,
  type CodeIpcApi,
} from "../shared/codeIpc";

function subscribe(channel: string, listener: (...args: never[]) => void): () => void {
  const wrapped = (_e: unknown, ...args: unknown[]) => (listener as (...a: unknown[]) => void)(...args);
  ipcRenderer.on(channel, wrapped as never);
  return () => ipcRenderer.removeListener(channel, wrapped as never);
}

const subscribeTask = <T>(channel: string, cb: (payload: T) => void): (() => void) =>
  subscribe(channel, cb as never);

const api: InnocenceCodeApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  getTheme: () => ipcRenderer.invoke(IPC.themeGet),
  setTheme: (mode: ThemeMode) => ipcRenderer.invoke(IPC.themeSet, mode),
  onThemeChanged: (cb) => subscribe(IPC.themeChanged, cb as never),
  listSessions: () => ipcRenderer.invoke(IPC.sessionsList),
  createSession: (options?: { title?: string; workspaceRoot?: string }) =>
    ipcRenderer.invoke(IPC.sessionCreate, options),
  deleteSession: (id) => ipcRenderer.invoke(IPC.sessionDelete, id),
  onSessionsChanged: (cb) => subscribe(IPC.sessionsChanged, cb as never),
  listMessages: (sessionId) => ipcRenderer.invoke(IPC.messagesList, sessionId),
  sendMessage: (sessionId, text) => ipcRenderer.invoke(IPC.chatSend, sessionId, text),
  stopMessage: (sessionId, messageId) => ipcRenderer.invoke(IPC.chatStop, sessionId, messageId),
  onChatDelta: (cb) => subscribe(IPC.chatDelta, cb as never),
  onChatDone: (cb) => subscribe(IPC.chatDone, cb as never),
  onChatError: (cb) => subscribe(IPC.chatError, cb as never),
  onChatTool: (cb) => subscribe(IPC.chatTool, cb as never),
  onChatThinking: (cb) => subscribe(IPC.chatThinking, cb as never),
  onChatPermission: (cb) => subscribe(IPC.chatPermission, cb as never),
  respondChatPermission: (requestId, choice) =>
    ipcRenderer.invoke(IPC.chatPermissionRespond, requestId, choice),
  pickWorkspace: () => ipcRenderer.invoke(IPC.workspacePick),
  getHarnessSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setHarnessSettings: (settings) => ipcRenderer.invoke(IPC.settingsSet, settings),
  listProviderModels: (profileId) => ipcRenderer.invoke(IPC.settingsModelsList, profileId),
  enrichModels: (providerName, ids) =>
    ipcRenderer.invoke(IPC.settingsEnrichModels, providerName, ids),
  onMenuNewSession: (cb) => subscribe(IPC.uiNewSession, cb as never),
  popupMenu: (id) => ipcRenderer.invoke(IPC.menuPopup, id),
};

/** Task review/route/complete API — narrow subset exposed to the renderer. */
const taskApi: TaskIpcApi = {
  start: (req) => ipcRenderer.invoke(TaskIpcChannels.taskStart, req),
  getTask: (req) => ipcRenderer.invoke(TaskIpcChannels.taskGet, req),
  changeTask: (req) => ipcRenderer.invoke(TaskIpcChannels.taskChange, req),
  checkpoint: (req) => ipcRenderer.invoke(TaskIpcChannels.taskCheckpoint, req),
  review: (req) => ipcRenderer.invoke(TaskIpcChannels.taskReview, req),
  restore: (req) => ipcRenderer.invoke(TaskIpcChannels.taskRestore, req),
  listRoutes: (req) => ipcRenderer.invoke(TaskIpcChannels.taskListRoutes, req),
  switchRoute: (req) => ipcRenderer.invoke(TaskIpcChannels.taskSwitchRoute, req),
  forkRoute: (req) => ipcRenderer.invoke(TaskIpcChannels.taskForkRoute, req),
  editUserMessage: (req) => ipcRenderer.invoke(TaskIpcChannels.taskEditUserMessage, req),
  retryAssistant: (req) => ipcRenderer.invoke(TaskIpcChannels.taskRetryAssistant, req),
  complete: (req) => ipcRenderer.invoke(TaskIpcChannels.taskComplete, req),
  applyAccepted: (req) => ipcRenderer.invoke(TaskIpcChannels.taskApply, req),
  resolveConflict: (req) => ipcRenderer.invoke(TaskIpcChannels.taskResolveConflict, req),
  validate: (req) => ipcRenderer.invoke(TaskIpcChannels.taskValidate, req),
  recoveryWarnings: (req) => ipcRenderer.invoke(TaskIpcChannels.taskRecoveryWarnings, req),
  recoverTask: (req) => ipcRenderer.invoke(TaskIpcChannels.taskRecover, req),
  onTaskEvent: (cb) => subscribeTask<TaskUiEvent>(TaskIpcChannels.taskEvent, cb),
  onTaskNotice: (cb) => subscribeTask<TaskUiNotice>(TaskIpcChannels.taskNotice, cb),
};

/** Read-only code panel API — route-scoped reads/search/external editor. */
const codeApi: CodeIpcApi = {
  readFile: (req) => ipcRenderer.invoke(CodeIpcChannels.codeReadFile, req),
  listFiles: (req) => ipcRenderer.invoke(CodeIpcChannels.codeListFiles, req),
  search: (req) => ipcRenderer.invoke(CodeIpcChannels.codeSearch, req),
  openExternalEditor: (req) => ipcRenderer.invoke(CodeIpcChannels.codeOpenExternalEditor, req),
};

contextBridge.exposeInMainWorld("innocencecode", api);
contextBridge.exposeInMainWorld("innocencecodeTask", taskApi);
contextBridge.exposeInMainWorld("innocencecodeCode", codeApi);
