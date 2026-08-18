// Theme handling — the renderer mirrors nativeTheme through the
// electron-dark / electron-light root classes (see webview index.html).
import { BrowserWindow, nativeTheme } from "electron";
import { IPC, type ThemeMode } from "../shared/ipc";

let mode: ThemeMode = "system";

export function getTheme(): { mode: ThemeMode; resolved: "dark" | "light" } {
  return {
    mode,
    resolved: nativeTheme.shouldUseDarkColors ? "dark" : "light",
  };
}

export function setTheme(next: ThemeMode): void {
  mode = next;
  nativeTheme.themeSource = next;
}

// Windows caption-button overlay colors — kept in lockstep with the
// --color-app-panel / --color-app-text tokens in app.css so the native
// minimize/maximize/close buttons never clash with the custom title bar.
export function titleBarOverlayFor(resolved: "dark" | "light"): {
  color: string;
  symbolColor: string;
  height: number;
} {
  return resolved === "dark"
    ? { color: "#141417", symbolColor: "#e6e6ea", height: 36 }
    : { color: "#ffffff", symbolColor: "#1a1a1e", height: 36 };
}

export function broadcastTheme(win: BrowserWindow): void {
  const theme = getTheme();
  if (win.isDestroyed()) return;
  win.webContents.send(IPC.themeChanged, theme.mode, theme.resolved);
  if (process.platform === "win32") {
    win.setTitleBarOverlay(titleBarOverlayFor(theme.resolved));
  }
}

export function watchTheme(win: BrowserWindow): void {
  nativeTheme.on("updated", () => broadcastTheme(win));
}
