// IPC surface — one handler per channel defined in src/shared/ipc.ts.
import { app, ipcMain } from "electron";
import { IPC, type MenuId } from "../shared/ipc";
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
import { getMainWindow } from "./appWindow";
import { popupMenu } from "./menu";
import { logger } from "./logger";

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
  ipcMain.handle(IPC.sessionCreate, (_e, title?: string) => sessions.createSession(title));
  ipcMain.handle(IPC.sessionDelete, (_e, id: string) => {
    disposeSession(id);
    sessions.deleteSession(id);
  });
  ipcMain.handle(IPC.messagesList, (_e, sessionId: string) => sessions.listMessages(sessionId));

  ipcMain.handle(IPC.chatSend, (_e, sessionId: string, text: string) => {
    needWindow();
    const trimmed = text.trim();
    if (!trimmed) throw new Error("empty message");
    sessions.appendMessage(sessionId, {
      id: `msg_${Date.now().toString(36)}_u`,
      role: "user",
      content: trimmed,
      createdAt: Date.now(),
    });
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

  ipcMain.handle(IPC.menuPopup, (_e, id: MenuId) => {
    popupMenu(needWindow(), id);
  });
}
