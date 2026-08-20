// @vitest-environment jsdom
// C2 (final review): the terminal bridge reaches the renderer. lib/ipc's
// terminalApi proxy reads window.innocencecodeTerminal — the exact surface
// the preload exposes — binding method calls to it and failing fast when the
// preload bridge is absent.
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalApi } from "./ipc";
import type { TerminalIpcApi } from "../../../shared/terminalIpc";

const windowRecord = window as unknown as Record<string, unknown>;

afterEach(() => {
  delete windowRecord.innocencecodeTerminal;
});

describe("terminalApi preload proxy (C2)", () => {
  it("binds every call to window.innocencecodeTerminal", async () => {
    const bridge: TerminalIpcApi = {
      create: vi.fn(async () => ({ taskId: "t1", routeId: "main", ptyId: "p1" })),
      write: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
      onTerminalOutput: vi.fn(() => () => {}),
      onTerminalExit: vi.fn(() => () => {}),
    };
    windowRecord.innocencecodeTerminal = bridge;

    await expect(terminalApi.create({ taskId: "t1", routeId: "main" })).resolves.toEqual({
      taskId: "t1",
      routeId: "main",
      ptyId: "p1",
    });
    expect(bridge.create).toHaveBeenCalledWith({ taskId: "t1", routeId: "main" });
    const off = terminalApi.onTerminalOutput(() => {});
    expect(bridge.onTerminalOutput).toHaveBeenCalled();
    off();
  });

  it("fails fast when the preload bridge is missing", () => {
    expect(() => terminalApi.create({ taskId: "t1", routeId: "main" })).toThrow(
      "preload bridge missing: window.innocencecodeTerminal is unavailable",
    );
  });
});
