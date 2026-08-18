// Pushes the session list to the renderer after every store mutation, so the
// sidebar never depends on pull-style refreshes (or chat completion) to
// notice a new/retitled/deleted session.
import { IPC } from "../shared/ipc";
import { getMainWindow } from "./appWindow";
import * as sessions from "./sessions";

export function broadcastSessions(): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.sessionsChanged, sessions.listSessions());
  }
}
