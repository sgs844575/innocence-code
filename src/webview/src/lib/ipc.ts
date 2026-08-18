// Renderer-side typed wrapper over the preload bridge. Fails fast if the
// preload did not run (e.g. opened in a plain browser) instead of pretending.
import type { InnocenceCodeApi } from "../../../shared/ipc";

declare global {
  interface Window {
    innocencecode: InnocenceCodeApi;
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
