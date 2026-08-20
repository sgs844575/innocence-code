// Renderer-side typed wrapper over the preload bridge. Fails fast if the
// preload did not run (e.g. opened in a plain browser) instead of pretending.
import type { InnocenceCodeApi } from "../../../shared/ipc";
import type { TaskIpcApi } from "../../../shared/taskIpc";
import type { CodeIpcApi } from "../../../shared/codeIpc";
import type { TerminalIpcApi } from "../../../shared/terminalIpc";

declare global {
  interface Window {
    innocencecode: InnocenceCodeApi;
    innocencecodeTask: TaskIpcApi;
    innocencecodeCode: CodeIpcApi;
    innocencecodeTerminal: TerminalIpcApi;
  }
}

export const api: InnocenceCodeApi = new Proxy({} as InnocenceCodeApi, {
  get(_target, prop: string) {
    if (typeof window === "undefined" || !window.innocencecode) {
      throw new Error("preload bridge missing: window.innocencecode is unavailable");
    }
    const value = (window.innocencecode as unknown as Record<string, unknown>)[prop];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(window.innocencecode) : value;
  },
});

/** Task review/route/complete API — narrow subset for the renderer. */
export const taskApi: TaskIpcApi = new Proxy({} as TaskIpcApi, {
  get(_target, prop: string) {
    if (typeof window === "undefined" || !window.innocencecodeTask) {
      throw new Error("preload bridge missing: window.innocencecodeTask is unavailable");
    }
    const value = (window.innocencecodeTask as unknown as Record<string, unknown>)[prop];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(window.innocencecodeTask)
      : value;
  },
});

/** Read-only code panel API — route-scoped reads/search/external editor. */
export const codeApi: CodeIpcApi = new Proxy({} as CodeIpcApi, {
  get(_target, prop: string) {
    if (typeof window === "undefined" || !window.innocencecodeCode) {
      throw new Error("preload bridge missing: window.innocencecodeCode is unavailable");
    }
    const value = (window.innocencecodeCode as unknown as Record<string, unknown>)[prop];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(window.innocencecodeCode)
      : value;
  },
});

/** Route-bound terminal API — the preload bridge behind TerminalPanel. */
export const terminalApi: TerminalIpcApi = new Proxy({} as TerminalIpcApi, {
  get(_target, prop: string) {
    if (typeof window === "undefined" || !window.innocencecodeTerminal) {
      throw new Error("preload bridge missing: window.innocencecodeTerminal is unavailable");
    }
    const value = (window.innocencecodeTerminal as unknown as Record<string, unknown>)[prop];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(window.innocencecodeTerminal)
      : value;
  },
});
