// Preload — the only bridge between the sandboxed renderer and the main
// process. Exposes a minimal, typed API surface (contextBridge) with
// sandbox + contextIsolation and no Node in the renderer.
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type InnocenceCodeApi, type ThemeMode } from "../shared/ipc";

function subscribe(channel: string, listener: (...args: never[]) => void): () => void {
  const wrapped = (_e: unknown, ...args: unknown[]) => (listener as (...a: unknown[]) => void)(...args);
  ipcRenderer.on(channel, wrapped as never);
  return () => ipcRenderer.removeListener(channel, wrapped as never);
}

const api: InnocenceCodeApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  getTheme: () => ipcRenderer.invoke(IPC.themeGet),
  setTheme: (mode: ThemeMode) => ipcRenderer.invoke(IPC.themeSet, mode),
  onThemeChanged: (cb) => subscribe(IPC.themeChanged, cb as never),
  listSessions: () => ipcRenderer.invoke(IPC.sessionsList),
  createSession: (title?: string) => ipcRenderer.invoke(IPC.sessionCreate, title),
  deleteSession: (id) => ipcRenderer.invoke(IPC.sessionDelete, id),
  onSessionsChanged: (cb) => subscribe(IPC.sessionsChanged, cb as never),
  listMessages: (sessionId) => ipcRenderer.invoke(IPC.messagesList, sessionId),
  sendMessage: (sessionId, text) => ipcRenderer.invoke(IPC.chatSend, sessionId, text),
  stopMessage: (sessionId, messageId) => ipcRenderer.invoke(IPC.chatStop, sessionId, messageId),
  onChatDelta: (cb) => subscribe(IPC.chatDelta, cb as never),
  onChatDone: (cb) => subscribe(IPC.chatDone, cb as never),
  onChatError: (cb) => subscribe(IPC.chatError, cb as never),
  onChatPermission: (cb) => subscribe(IPC.chatPermission, cb as never),
  respondChatPermission: (requestId, choice) =>
    ipcRenderer.invoke(IPC.chatPermissionRespond, requestId, choice),
  pickWorkspace: () => ipcRenderer.invoke(IPC.workspacePick),
  getHarnessSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setHarnessSettings: (settings) => ipcRenderer.invoke(IPC.settingsSet, settings),
  listProviderModels: (profileId) => ipcRenderer.invoke(IPC.settingsModelsList, profileId),
  onMenuNewSession: (cb) => subscribe(IPC.uiNewSession, cb as never),
  popupMenu: (id) => ipcRenderer.invoke(IPC.menuPopup, id),
};

contextBridge.exposeInMainWorld("innocencecode", api);
