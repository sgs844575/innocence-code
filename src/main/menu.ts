// Native menu templates, localized through src/main/locales. The custom title
// bar renders File/Edit/View/Help as plain text and asks the main process to
// pop up the matching native submenu at the button's position — same content,
// no native menu bar.
import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  type MenuItemConstructorOptions,
} from "electron";
import { broadcastTheme, getTheme, setTheme } from "./theme";
import { IPC, type MenuId, type ThemeMode } from "../shared/ipc";
import zhCN from "./locales/zh-CN.json";
import enUS from "./locales/en-US.json";

type Dict = Record<string, string>;

function loadDict(): Dict {
  return app.getLocale().toLowerCase().startsWith("zh") ? zhCN : enUS;
}

function themeSubmenu(win: BrowserWindow, t: Dict): MenuItemConstructorOptions[] {
  const item = (label: string, value: ThemeMode): MenuItemConstructorOptions => ({
    label,
    type: "radio",
    checked: getTheme().mode === value,
    click: () => {
      setTheme(value);
      broadcastTheme(win);
    },
  });
  return [item(t["menu.theme.system"], "system"), item(t["menu.theme.dark"], "dark"), item(t["menu.theme.light"], "light")];
}

function fileMenu(win: BrowserWindow, t: Dict): MenuItemConstructorOptions[] {
  const isMac = process.platform === "darwin";
  return [
    {
      label: t["menu.file.newSession"],
      accelerator: "CmdOrCtrl+N",
      click: () => win.webContents.send(IPC.uiNewSession),
    },
    { type: "separator" },
    isMac ? { role: "close", label: t["menu.file.closeWindow"] } : { role: "quit" },
  ];
}

function editMenu(t: Dict): MenuItemConstructorOptions[] {
  return [
    { role: "undo", label: t["menu.edit.undo"] },
    { role: "redo", label: t["menu.edit.redo"] },
    { type: "separator" },
    { role: "cut", label: t["menu.edit.cut"] },
    { role: "copy", label: t["menu.edit.copy"] },
    { role: "paste", label: t["menu.edit.paste"] },
    { role: "selectAll", label: t["menu.edit.selectAll"] },
  ];
}

function viewMenu(win: BrowserWindow, t: Dict): MenuItemConstructorOptions[] {
  return [
    { role: "reload", label: t["menu.view.reload"] },
    { role: "forceReload" },
    { role: "toggleDevTools", label: t["menu.view.toggleDevTools"] },
    { type: "separator" },
    { role: "resetZoom", label: t["menu.view.resetZoom"] },
    { role: "zoomIn", label: t["menu.view.zoomIn"] },
    { role: "zoomOut", label: t["menu.view.zoomOut"] },
    { type: "separator" },
    { label: t["menu.theme"], submenu: themeSubmenu(win, t) },
  ];
}

function helpMenu(win: BrowserWindow, t: Dict): MenuItemConstructorOptions[] {
  return [
    {
      label: t["menu.help.about"],
      click: () => {
        void dialog.showMessageBox(win, {
          type: "info",
          title: t["menu.help.about"],
          message: `InnocenceCode ${app.getVersion()}`,
          detail: "AI coding assistant desktop client (Electron + Forge + Vite + React).",
        });
      },
    },
  ];
}

/** Shows a native submenu at the current cursor position — used by the
 * custom title bar's File/Edit/View/Help text buttons. */
export function popupMenu(win: BrowserWindow, id: MenuId): void {
  const t = loadDict();
  const template: Record<MenuId, MenuItemConstructorOptions[]> = {
    file: fileMenu(win, t),
    edit: editMenu(t),
    view: viewMenu(win, t),
    help: helpMenu(win, t),
  };
  Menu.buildFromTemplate(template[id]).popup({ window: win });
}

/** macOS still gets a real application menu (the system requires one for
 * the app-name menu with Quit/Hide); other platforms rely on the custom
 * title bar buttons above, so the native menu bar is not set there. */
export function buildAppMenu(win: BrowserWindow): Menu | null {
  if (process.platform !== "darwin") return null;
  const t = loadDict();
  const template: MenuItemConstructorOptions[] = [
    {
      label: t["menu.app.name"],
      submenu: [
        { role: "about", label: t["menu.help.about"] },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { label: t["menu.file"], submenu: fileMenu(win, t) },
    { label: t["menu.edit"], submenu: editMenu(t) },
    { label: t["menu.view"], submenu: viewMenu(win, t) },
    { label: t["menu.help"], submenu: helpMenu(win, t) },
  ];
  return Menu.buildFromTemplate(template);
}
