// Main window creation:
// - show on 'ready-to-show' to avoid a white flash
// - sandbox + contextIsolation preloads
// - renderer served from the custom innocencecode:// scheme in production,
//   vite dev server during development
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { appIndexUrl } from "./protocol";
import { logger } from "./logger";
import { getTheme, titleBarOverlayFor } from "./theme";

let mainWindow: BrowserWindow | undefined;

export function getMainWindow(): BrowserWindow | undefined {
  return mainWindow;
}

export async function createMainWindow(): Promise<BrowserWindow> {
  // Match the window chrome to whatever theme is active right now, so the
  // Windows caption-button overlay never mismatches the custom title bar
  // (it previously stayed hardcoded dark and clashed with the light theme).
  const resolved = getTheme().resolved;

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: resolved === "dark" ? "#0d0d0f" : "#f7f7f8",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay: process.platform === "win32" ? titleBarOverlayFor(resolved) : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  // MAIN_WINDOW_VITE_DEV_SERVER_URL is a build-time constant injected by
  // @electron-forge/plugin-vite (see vite-env.d.ts) — NOT process.env. It is
  // the dev server URL under `electron-forge start`, and statically replaced
  // with `undefined` in production builds, so packaged builds always take
  // the innocencecode:// branch below.
  const devServerUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
  // Optional load verification hook: set InnocenceCode_SMOKE_OUT=<path> and the app
  // writes the load outcome there and exits (used by tools/smoke-test.cjs).
  const smokeOut = process.env.InnocenceCode_SMOKE_OUT;
  try {
    if (devServerUrl) {
      await win.loadURL(devServerUrl);
    } else {
      await win.loadURL(appIndexUrl());
    }
    if (smokeOut) {
      // loadURL resolves even for a 404 response body from our own protocol
      // handler, so verify actual rendered content, not just the promise.
      const title = win.webContents.getTitle();
      const bodyText: string = await win.webContents.executeJavaScript(
        "document.body.innerText.slice(0, 200)",
      );
      const failed = /not found/i.test(bodyText) || bodyText.trim() === "";
      fs.writeFileSync(smokeOut, failed ? `fail body="${bodyText}"` : `ok title="${title}"`);
      app.quit();
    }
  } catch (err) {
    logger.error("renderer failed to load", {
      via: devServerUrl ? "dev-server" : "app-scheme",
      error: String(err),
    });
    if (smokeOut) {
      fs.writeFileSync(smokeOut, `fail ${String(err)}`);
      app.quit();
    }
  }

  // Block any navigation away from our own origins.
  const allowed = new Set([devServerUrl, "innocencecode://app"].filter(Boolean) as string[]);
  win.webContents.on("will-navigate", (event, url) => {
    if (![...allowed].some((origin) => url.startsWith(origin))) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  return win;
}
