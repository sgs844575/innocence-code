// Theme glue: mirrors nativeTheme into the root class names used by
// app.css and the startup loader (electron-dark / electron-light).
import { api } from "./ipc";
import type { ResolvedTheme, ThemeMode } from "../../../shared/ipc";

export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle("electron-dark", resolved === "dark");
  root.classList.toggle("electron-light", resolved === "light");
}

let current: { mode: ThemeMode; resolved: ResolvedTheme } | undefined;

export function currentTheme() {
  return current;
}

export async function initTheme(): Promise<void> {
  const theme = await api.getTheme();
  current = theme;
  applyTheme(theme.resolved);
  api.onThemeChanged((mode, resolved) => {
    current = { mode, resolved };
    applyTheme(resolved);
  });
}
