// InnocenceCode main entry: single-instance lock, protocol registration,
// then window.
import { app, Menu } from "electron";
import { handleAppScheme, registerAppScheme } from "./protocol";
import { createMainWindow, getMainWindow } from "./appWindow";
import { registerIpcHandlers } from "./ipc";
import { buildAppMenu } from "./menu";
import { watchTheme } from "./theme";
import { logger } from "./logger";

// Custom schemes must be registered before app ready.
registerAppScheme();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady()
    .then(async () => {
      handleAppScheme();
      registerIpcHandlers();

      const win = await createMainWindow();
      // Non-mac: the custom title bar's File/Edit/View/Help buttons pop up
      // menus on demand (see src/main/menu.ts popupMenu), so no menu bar.
      Menu.setApplicationMenu(buildAppMenu(win));
      watchTheme(win);

      logger.info("app ready", { version: app.getVersion(), platform: process.platform });
    })
    .catch((err) => {
      logger.error("startup failed", { error: String(err) });
      app.quit();
    });

  // Keep running on macOS after all windows close.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (getMainWindow() === undefined) void createMainWindow();
  });
}

// Crash reporting hook — placeholder for a real crash-reporter pipeline.
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { message: err.message, stack: err.stack });
});
