// InnocenceCode main entry: single-instance lock, protocol registration,
// then window.
import { app, Menu } from "electron";
import { handleAppScheme, registerAppScheme } from "./protocol";
import { createMainWindow, getMainWindow } from "./appWindow";
import { registerIpcHandlers } from "./ipc";
import {
  getHarnessSettings,
  getTaskBridge,
  getTaskStorageDir,
  initHarness,
  disposeAllRuntime,
  disposeTaskRuntime,
  rejectPendingPermissionAsks,
  resolveRouteWorkspaceRoot,
} from "./harnessGlue";
import { initSessionStore } from "./sessions";
import { buildAppMenu } from "./menu";
import { watchTheme } from "./theme";
import { logger } from "./logger";
import { ShutdownGate } from "./shutdown";
import { createTerminalIpcService, registerTerminalIpc, type TerminalIpcService } from "./terminalIpc";
import { recoverPersistedTaskRuntimes, wireTaskRuntimeIpc } from "./taskRuntimeIpc";

// Custom schemes must be registered before app ready.
registerAppScheme();

/** Terminal IPC service — disposed on quit so no shell trees survive exit. */
let terminalService: TerminalIpcService | undefined;

/** Renderer push port shared by every task-runtime surface. */
const broadcast = (channel: string, payload: unknown): void => {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

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
      initSessionStore(app.getPath("userData"));
      registerIpcHandlers();
      await initHarness();

      // Task runtime IPC composition (Task 12): task handlers over the real
      // bridge-backed command service, route-scoped code surfaces, and the
      // task-event broadcast feeding the renderer's workbench state.
      const taskRuntimeDeps = {
        bridge: getTaskBridge(),
        taskStorageDir: getTaskStorageDir(),
        resolveRouteRoot: resolveRouteWorkspaceRoot,
        getEditorCommand: () => getHarnessSettings().externalEditorCommand ?? "",
        send: broadcast,
        log: (level: "info" | "warn" | "error", msg: string, data?: unknown) =>
          logger[level](msg, data),
      };
      await wireTaskRuntimeIpc(taskRuntimeDeps);

      // Route-bound terminals (Task 9): the service resolves each terminal's
      // cwd from the task bridge's route handle; output/exit events are
      // pushed to the main window through the standard broadcast pattern.
      terminalService = createTerminalIpcService({
        resolveRouteCwd: resolveRouteWorkspaceRoot,
        send: broadcast,
      });
      await registerTerminalIpc(terminalService);

      const win = await createMainWindow();
      // Non-mac: the custom title bar's File/Edit/View/Help buttons pop up
      // menus on demand (see src/main/menu.ts popupMenu), so no menu bar.
      Menu.setApplicationMenu(buildAppMenu(win));
      watchTheme(win);

      // Restart recovery runs once the renderer mounted its task-event
      // subscriptions — notices pushed before that would be lost.
      win.webContents.once("did-finish-load", () => {
        void recoverPersistedTaskRuntimes(taskRuntimeDeps).catch((err) => {
          logger.error("task restart recovery failed", { error: String(err) });
        });
      });

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

  // Async shutdown, run exactly once: the harness owns OS resources (MCP
  // child processes, in-flight builds, pending permission asks) that must be
  // released before quit. Every quit attempt BEFORE the release completes is
  // preventDefault'ed — including re-entrant attempts arriving mid-release
  // (e.g. window-all-closed firing app.quit() again), which would otherwise
  // exit the process mid-disposeAllRuntime. Once the gate is released, the
  // final app.quit() goes through untouched.
  const shutdown = new ShutdownGate();
  app.on("before-quit", (e) => {
    const phase = shutdown.onBeforeQuit();
    if (phase === "release") return;
    e.preventDefault();
    if (phase === "hold") return; // release already running; just hold this quit
    void (async () => {
      try {
        rejectPendingPermissionAsks();
        // Agent sessions first (aborts in-flight tool invocations, which
        // releases their task mutation leases), then the task runtime's
        // watchers and worktree lease records. Terminal shell trees go last
        // (taskkill /T /F on Windows) so quit leaves no orphan shells.
        await disposeAllRuntime();
        await disposeTaskRuntime();
        await terminalService?.disposeAll();
      } catch (err) {
        logger.error("shutdown dispose failed", { error: String(err) });
      } finally {
        shutdown.markReleased();
        app.quit();
      }
    })();
  });

  app.on("activate", () => {
    if (getMainWindow() === undefined) void createMainWindow();
  });
}

// Crash reporting hook — placeholder for a real crash-reporter pipeline.
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { message: err.message, stack: err.stack });
});
