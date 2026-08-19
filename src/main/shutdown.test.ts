// Shutdown gate state machine — the before-quit handshake extracted from
// index.ts so the release window is testable without Electron.
import { describe, expect, it } from "vitest";
import { ShutdownGate } from "./shutdown";

describe("ShutdownGate (async before-quit handshake)", () => {
  it("the first before-quit starts the release: caller preventDefaults and runs the dispose work", () => {
    const gate = new ShutdownGate();
    expect(gate.onBeforeQuit()).toBe("start");
  });

  it("re-entrant quits DURING the release are held, never bypass it", () => {
    const gate = new ShutdownGate();
    gate.onBeforeQuit(); // release starts
    // A second quit racing the in-flight disposeAllRuntime (e.g. a
    // window-all-closed firing app.quit()) must be preventDefault'ed again,
    // or the process exits mid-release and leaks detached MCP processes.
    expect(gate.onBeforeQuit()).toBe("hold");
    expect(gate.onBeforeQuit()).toBe("hold");
  });

  it("after markReleased the gate lets every later quit through untouched", () => {
    const gate = new ShutdownGate();
    gate.onBeforeQuit();
    gate.markReleased();
    expect(gate.onBeforeQuit()).toBe("release");
    expect(gate.onBeforeQuit()).toBe("release");
  });

  it("independent gates do not share state", () => {
    const a = new ShutdownGate();
    const b = new ShutdownGate();
    a.onBeforeQuit();
    expect(b.onBeforeQuit()).toBe("start");
    expect(a.onBeforeQuit()).toBe("hold");
  });
});
