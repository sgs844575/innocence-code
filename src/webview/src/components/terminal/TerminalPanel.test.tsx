// @vitest-environment jsdom
// TerminalPanel + terminalState tests. terminalState is pure logic (no
// xterm); the panel rendering tests mock @xterm/xterm (canvas renderer is
// unusable in jsdom) and drive the panel purely through typed events.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TerminalCreateRequest,
  TerminalExitEvent,
  TerminalOutputEvent,
} from "../../../../shared/terminalIpc";
import { Terminal } from "@xterm/xterm";
import { TerminalPanel } from "./TerminalPanel";
import {
  addTerminal,
  emptyTerminalState,
  markStaleRoutes,
  markTerminalExited,
  removeTerminal,
  setActiveTerminal,
} from "./terminalState";

vi.mock("@xterm/xterm", () => ({
  // `function` implementations are required for `new Terminal()` mocks.
  Terminal: vi.fn(function () {
    return {
      write: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(),
      loadAddon: vi.fn(),
      open: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      element: null,
    };
  }),
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function () {
    return {
      load: vi.fn(),
      fit: vi.fn(),
      dispose: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
    };
  }),
}));

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Fake terminal API (typed events only — the panel never sees ipcRenderer)
// ---------------------------------------------------------------------------

function fakeTerminalApi() {
  let seq = 0;
  const outputSubs = new Set<(e: TerminalOutputEvent) => void>();
  const exitSubs = new Set<(e: TerminalExitEvent) => void>();
  return {
    create: vi.fn(async (req: TerminalCreateRequest) => ({
      ptyId: `pty_${++seq}`,
      taskId: req.taskId,
      routeId: req.routeId,
    })),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    onTerminalOutput: vi.fn((cb: (e: TerminalOutputEvent) => void) => {
      outputSubs.add(cb);
      return () => outputSubs.delete(cb);
    }),
    onTerminalExit: vi.fn((cb: (e: TerminalExitEvent) => void) => {
      exitSubs.add(cb);
      return () => exitSubs.delete(cb);
    }),
    emitOutput: (e: TerminalOutputEvent) => {
      for (const cb of outputSubs) cb(e);
    },
    emitExit: (e: TerminalExitEvent) => {
      for (const cb of exitSubs) cb(e);
    },
  };
}
type FakeApi = ReturnType<typeof fakeTerminalApi>;

/** The xterm instances the mocked Terminal class produced (newest last). */
function xtermInstances(): Array<{ write: ReturnType<typeof vi.fn>; onData: ReturnType<typeof vi.fn> }> {
  return vi.mocked(Terminal).mock.instances as never;
}

// ---------------------------------------------------------------------------
// terminalState — pure logic
// ---------------------------------------------------------------------------

describe("terminalState", () => {
  const active = { taskId: "t1", routeId: "r1" };

  it("addTerminal appends, activates, and computes staleness against the active route", () => {
    let state = emptyTerminalState;
    state = addTerminal(state, { ptyId: "p1", taskId: "t1", routeId: "r1" }, active);
    state = addTerminal(state, { ptyId: "p2", taskId: "t1", routeId: "r2" }, active);
    expect(state.order).toEqual(["p1", "p2"]);
    expect(state.entries.p1).toMatchObject({ ptyId: "p1", stale: false });
    expect(state.entries.p2).toMatchObject({ ptyId: "p2", stale: true });
    expect(state.activePtyId).toBe("p2");
  });

  it("markStaleRoutes flags every entry not on the active route (route switch)", () => {
    let state = emptyTerminalState;
    state = addTerminal(state, { ptyId: "p1", taskId: "t1", routeId: "r1" }, active);
    state = addTerminal(state, { ptyId: "p2", taskId: "t1", routeId: "r2" }, active);
    // User switches to route r2.
    state = markStaleRoutes(state, { taskId: "t1", routeId: "r2" });
    expect(state.entries.p1.stale).toBe(true);
    expect(state.entries.p2.stale).toBe(false);
    // No active task at all: everything is old.
    state = markStaleRoutes(state, null);
    expect(state.entries.p1.stale).toBe(true);
    expect(state.entries.p2.stale).toBe(true);
  });

  it("markTerminalExited records the exit code but keeps the entry until closed", () => {
    let state = emptyTerminalState;
    state = addTerminal(state, { ptyId: "p1", taskId: "t1", routeId: "r1" }, active);
    state = markTerminalExited(state, "p1", 3);
    expect(state.entries.p1).toMatchObject({ exited: true, exitCode: 3 });
    expect(state.order).toEqual(["p1"]);
  });

  it("removeTerminal activates the newest remaining live entry (non-stale preferred)", () => {
    let state = emptyTerminalState;
    state = addTerminal(state, { ptyId: "p1", taskId: "t1", routeId: "r1" }, active);
    state = addTerminal(state, { ptyId: "p2", taskId: "t1", routeId: "r2" }, active);
    state = setActiveTerminal(state, "p1");
    state = removeTerminal(state, "p1");
    expect(state.order).toEqual(["p2"]);
    expect(state.activePtyId).toBe("p2");
    state = removeTerminal(state, "p2");
    expect(state.order).toEqual([]);
    expect(state.activePtyId).toBeNull();
  });

  it("setActiveTerminal only switches within known entries", () => {
    let state = emptyTerminalState;
    state = addTerminal(state, { ptyId: "p1", taskId: "t1", routeId: "r1" }, active);
    state = setActiveTerminal(state, "p-unknown");
    expect(state.activePtyId).toBe("p1");
  });
});

// ---------------------------------------------------------------------------
// TerminalPanel — rendering with fake events
// ---------------------------------------------------------------------------

describe("TerminalPanel", () => {
  let api: FakeApi;

  beforeEach(() => {
    vi.clearAllMocks();
    api = fakeTerminalApi();
  });

  it("auto-creates a terminal for the active route and renders its tab", async () => {
    render(<TerminalPanel api={api} activeTask={{ taskId: "t1", routeId: "main" }} />);
    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ taskId: "t1", routeId: "main" }));
    await screen.findByRole("tab", { name: /main/ });
    // xterm mounted exactly once for it.
    await waitFor(() => expect(xtermInstances()).toHaveLength(1));
    // Fit-driven initial resize went through the typed DTO.
    await waitFor(() =>
      expect(api.resize).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "t1", routeId: "main", cols: 80, rows: 24 }),
      ),
    );
  });

  it("does not create when the active route already has a live terminal", async () => {
    const { rerender } = render(
      <TerminalPanel api={api} activeTask={{ taskId: "t1", routeId: "main" }} />,
    );
    await screen.findByRole("tab", { name: /main/ });
    expect(api.create).toHaveBeenCalledTimes(1);
    rerender(<TerminalPanel api={api} activeTask={{ taskId: "t1", routeId: "main" }} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("feeds output events into the matching xterm instance", async () => {
    render(<TerminalPanel api={api} activeTask={{ taskId: "t1", routeId: "main" }} />);
    await screen.findByRole("tab", { name: /main/ });
    await waitFor(() => expect(xtermInstances()).toHaveLength(1));
    const term = xtermInstances()[0];
    await act(async () => {
      api.emitOutput({ taskId: "t1", routeId: "main", ptyId: "pty_1", data: "hello shell" });
    });
    expect(term.write).toHaveBeenCalledWith("hello shell");
  });

  it("sends keystrokes as typed write DTOs", async () => {
    render(<TerminalPanel api={api} activeTask={{ taskId: "t1", routeId: "main" }} />);
    await screen.findByRole("tab", { name: /main/ });
    await waitFor(() => expect(xtermInstances()).toHaveLength(1));
    const term = xtermInstances()[0];
    expect(term.onData).toHaveBeenCalled();
    const onData = term.onData.mock.calls[0][0] as (data: string) => void;
    await act(async () => {
      onData("npm test\r");
    });
    expect(api.write).toHaveBeenCalledWith({
      taskId: "t1",
      routeId: "main",
      ptyId: "pty_1",
      data: "npm test\r",
    });
  });

  it("route switch marks the old terminal 旧路线 and creates a fresh one (never reused)", async () => {
    const { rerender } = render(
      <TerminalPanel api={api} activeTask={{ taskId: "t1", routeId: "main" }} />,
    );
    await screen.findByRole("tab", { name: /main/ });

    rerender(<TerminalPanel api={api} activeTask={{ taskId: "t1", routeId: "route_x" }} />);
    await screen.findByRole("tab", { name: /route_x/ });
    expect(api.create).toHaveBeenCalledWith({ taskId: "t1", routeId: "route_x" });
    // Old route tab is flagged and shows a close button.
    const oldTab = screen.getByRole("tab", { name: /main/ });
    expect(oldTab.textContent).toContain("旧路线");
    expect(screen.getByRole("button", { name: "关闭旧路线终端 main" })).toBeTruthy();
    // Two xterm frontends are mounted — one per pty.
    await waitFor(() => expect(xtermInstances()).toHaveLength(2));
  });

  it("closing a stale terminal disposes it through the API and removes the tab", async () => {
    const { rerender } = render(
      <TerminalPanel api={api} activeTask={{ taskId: "t1", routeId: "main" }} />,
    );
    await screen.findByRole("tab", { name: /main/ });
    rerender(<TerminalPanel api={api} activeTask={{ taskId: "t1", routeId: "route_x" }} />);
    await screen.findByRole("tab", { name: /route_x/ });

    fireEvent.click(screen.getByRole("button", { name: "关闭旧路线终端 main" }));
    await waitFor(() =>
      expect(api.dispose).toHaveBeenCalledWith({
        taskId: "t1",
        routeId: "main",
        ptyId: "pty_1",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("tab", { name: /main/ })).toBeNull());
  });

  it("shows 已退出 after an exit event until closed", async () => {
    render(<TerminalPanel api={api} activeTask={{ taskId: "t1", routeId: "main" }} />);
    await screen.findByRole("tab", { name: /main/ });
    await act(async () => {
      api.emitExit({ taskId: "t1", routeId: "main", ptyId: "pty_1", exitCode: 0 });
    });
    expect(screen.getByRole("tab", { name: /main/ }).textContent).toContain("已退出");
  });

  it("subscribes exactly once to output/exit regardless of rerenders", async () => {
    const { rerender } = render(
      <TerminalPanel api={api} activeTask={{ taskId: "t1", routeId: "main" }} />,
    );
    await screen.findByRole("tab", { name: /main/ });
    rerender(<TerminalPanel api={api} activeTask={{ taskId: "t1", routeId: "main" }} />);
    rerender(<TerminalPanel api={api} activeTask={{ taskId: "t1", routeId: "other" }} />);
    await screen.findByRole("tab", { name: /other/ });
    expect(api.onTerminalOutput).toHaveBeenCalledTimes(1);
    expect(api.onTerminalExit).toHaveBeenCalledTimes(1);
  });

  it("panel close button invokes onClose", async () => {
    const onClose = vi.fn();
    render(<TerminalPanel api={api} activeTask={{ taskId: "t1", routeId: "main" }} onClose={onClose} />);
    await screen.findByRole("tab", { name: /main/ });
    fireEvent.click(screen.getByRole("button", { name: "收起终端面板" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
