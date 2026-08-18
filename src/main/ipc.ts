// IPC surface — one handler per channel defined in src/shared/ipc.ts.
import { app, ipcMain } from "electron";
import { IPC, type MenuId } from "../shared/ipc";
import { broadcastTheme, getTheme, setTheme } from "./theme";
import * as sessions from "./sessions";
import { startStream, stopStream } from "./mockAgent";
import { getMainWindow } from "./appWindow";
import { popupMenu } from "./menu";
import { logger } from "./logger";

export function registerIpcHandlers(): void {
  const win = () => getMainWindow();
  const needWindow = () => {
    const w = win();
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
    sessions.deleteSession(id);
  });
  ipcMain.handle(IPC.messagesList, (_e, sessionId: string) => sessions.listMessages(sessionId));

  ipcMain.handle(IPC.chatSend, (_e, sessionId: string, text: string) => {
    const w = needWindow();
    const trimmed = text.trim();
    if (!trimmed) throw new Error("empty message");
    sessions.appendMessage(sessionId, {
      id: `msg_${Date.now().toString(36)}_u`,
      role: "user",
      content: trimmed,
      createdAt: Date.now(),
    });
    const messageId = startStream(w, sessionId, trimmed);
    logger.info("chat:send", { sessionId, messageId });
    return { messageId };
  });

  ipcMain.handle(IPC.chatStop, (_e, sessionId: string, messageId: string) => {
    stopStream(sessionId, messageId);
  });

  ipcMain.handle(IPC.menuPopup, (_e, id: MenuId) => {
    popupMenu(needWindow(), id);
  });
}
