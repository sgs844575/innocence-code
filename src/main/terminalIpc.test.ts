// Tests for TerminalIpcService — DTO validation, cwd resolution through the
// bridge port, and event forwarding to the renderer. Uses a fake PtyManager
// (the real node-pty manager is covered by packages/terminal-pty/tests).
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { PtyEvent, PtyExitEvent, PtyManager, PtySession } from "@innocencecode/terminal-pty";
import { TerminalIpcChannels } from "../shared/terminalIpc";
import { createTerminalIpcService } from "./terminalIpc";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeSession implements PtySession {
  readonly ptyId: string;
  readonly taskId: string;
  readonly routeId: string;
  readonly cwd: string;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  disposed = false;
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  constructor(init: { ptyId: string; taskId: string; routeId: string; cwd: string }) {
    this.ptyId = init.ptyId;
    this.taskId = init.taskId;
    this.routeId = init.routeId;
    this.cwd = init.cwd;
  }

  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  output: () => Promise<string> = async () => "";
  onExit(listener: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  dispose: () => Promise<void> = async () => {
    this.disposed = true;
  };
}

class FakeManager implements PtyManager {
  readonly sessions = new Map<string, FakeSession>();
  readonly createInputs: Array<{ taskId: string; routeId: string; cwd: string; cols?: number; rows?: number }> = [];
  disposeAllCalls = 0;
  private seq = 0;
  private eventSink: ((event: PtyEvent) => void) | undefined;

  constructor(onEvent?: (event: PtyEvent) => void) {
    this.eventSink = onEvent;
  }

  /** Test hook: pretend the shell produced output / exited. */
  emit(event: PtyEvent): void {
    this.eventSink?.(event);
  }

  create = async (input: { taskId: string; routeId: string; cwd: string; cols?: number; rows?: number }) => {
    this.createInputs.push({ ...input });
    const session = new FakeSession({
      ptyId: `pty_fake_${++this.seq}`,
      taskId: input.taskId,
      routeId: input.routeId,
      cwd: input.cwd,
    });
    this.sessions.set(`${input.taskId}::${input.routeId}`, session);
    return session;
  };
  get = (taskId: string, routeId: string) => this.sessions.get(`${taskId}::${routeId}`);
  disposeForRoute = async (taskId: string, routeId: string) => {
    const session = this.sessions.get(`${taskId}::${routeId}`);
    if (session) {
      session.disposed = true;
      this.sessions.delete(`${taskId}::${routeId}`);
    }
  };
  disposeAll = async () => {
    this.disposeAllCalls += 1;
    for (const [key, session] of this.sessions) {
      session.disposed = true;
      this.sessions.delete(key);
    }
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let manager: FakeManager;
let send: Mock<(channel: string, payload: unknown) => void>;
let resolveRouteCwd: Mock<(taskId: string, routeId: string) => string | undefined>;

beforeEach(() => {
  send = vi.fn();
  resolveRouteCwd = vi.fn(() => "C:/worktrees/t1/r1");
  manager = new FakeManager();
});

function buildService(overrides?: { routes?: Record<string, string | undefined> }) {
  const routes = overrides?.routes;
  const resolver =
    routes === undefined
      ? resolveRouteCwd
      : vi.fn((taskId: string, routeId: string) => routes[`${taskId}/${routeId}`]);
  return {
    resolver,
    service: createTerminalIpcService({
      resolveRouteCwd: resolver,
      send,
      createManager: (onEvent) => {
        manager = new FakeManager(onEvent);
        return manager;
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TerminalIpcService.create", () => {
  it("resolves cwd from the bridge route handle — renderer passes ids only", async () => {
    const { service } = buildService();
    const created = await service.create({ taskId: "t1", routeId: "r1", cols: 100, rows: 30 });
    expect(manager.createInputs).toEqual([
      { taskId: "t1", routeId: "r1", cwd: "C:/worktrees/t1/r1", cols: 100, rows: 30 },
    ]);
    expect(created).toMatchObject({ taskId: "t1", routeId: "r1", ptyId: "pty_fake_1" });
  });

  it("defaults the grid to 80x24 when cols/rows are omitted", async () => {
    const { service } = buildService();
    await service.create({ taskId: "t1", routeId: "r1" });
    expect(manager.createInputs[0]).toMatchObject({ cols: 80, rows: 24 });
  });

  it("rejects absolute-path-shaped taskIds and routeIds", async () => {
    const { service } = buildService();
    await expect(service.create({ taskId: "C:\\evil", routeId: "r1" })).rejects.toThrow(/unsafe taskId/);
    await expect(service.create({ taskId: "t1", routeId: "../../etc" })).rejects.toThrow(/unsafe routeId/);
    await expect(service.create({ taskId: "/abs/path", routeId: "r1" })).rejects.toThrow(/unsafe taskId/);
    expect(manager.createInputs).toHaveLength(0);
  });

  it("rejects unknown task/route (bridge has no live handle)", async () => {
    const { service } = buildService({ routes: { "t1/r1": undefined } });
    await expect(service.create({ taskId: "t1", routeId: "r1" })).rejects.toThrow(/unknown task\/route/);
    expect(manager.createInputs).toHaveLength(0);
  });
});

describe("TerminalIpcService.write/resize", () => {
  it("routes input text to the matching live session", async () => {
    const { service } = buildService();
    const created = await service.create({ taskId: "t1", routeId: "r1" });
    await service.write({ ...created, data: "npm test\r" });
    const session = manager.get("t1", "r1") as FakeSession;
    expect(session.writes).toEqual(["npm test\r"]);
  });

  it("rejects a stale ptyId (session replaced or gone)", async () => {
    const { service } = buildService();
    await service.create({ taskId: "t1", routeId: "r1" });
    await expect(
      service.write({ taskId: "t1", routeId: "r1", ptyId: "pty_stale", data: "x" }),
    ).rejects.toThrow(/no live pty/);
    const session = manager.get("t1", "r1") as FakeSession;
    expect(session.writes).toHaveLength(0);
  });

  it("rejects non-string data", async () => {
    const { service } = buildService();
    const created = await service.create({ taskId: "t1", routeId: "r1" });
    await expect(
      service.write({ ...created, data: undefined as unknown as string }),
    ).rejects.toThrow(/string data/);
  });

  it("resizes with validated positive integer dimensions", async () => {
    const { service } = buildService();
    const created = await service.create({ taskId: "t1", routeId: "r1" });
    await service.resize({ ...created, cols: 120, rows: 40 });
    const session = manager.get("t1", "r1") as FakeSession;
    expect(session.resizes).toEqual([{ cols: 120, rows: 40 }]);
    await expect(service.resize({ ...created, cols: 0, rows: 40 })).rejects.toThrow(/cols/);
    await expect(service.resize({ ...created, cols: 120, rows: -3 })).rejects.toThrow(/rows/);
  });
});

describe("TerminalIpcService.dispose", () => {
  it("disposes the route when the ptyId matches the live session", async () => {
    const { service } = buildService();
    const created = await service.create({ taskId: "t1", routeId: "r1" });
    await service.dispose(created);
    const session = manager.get("t1", "r1");
    expect(session).toBeUndefined();
  });

  it("rejects a stale ptyId instead of killing a stranger's terminal", async () => {
    const { service } = buildService();
    await service.create({ taskId: "t1", routeId: "r1" });
    await expect(
      service.dispose({ taskId: "t1", routeId: "r1", ptyId: "pty_stale" }),
    ).rejects.toThrow(/stale ptyId/);
    expect(manager.get("t1", "r1")).toBeDefined();
  });

  it("disposeAll fans out to the manager", async () => {
    const { service } = buildService();
    await service.disposeAll();
    expect(manager.disposeAllCalls).toBe(1);
  });
});

describe("TerminalIpcService event forwarding", () => {
  it("forwards output events on terminal:output with the identity triple", async () => {
    const { service } = buildService();
    await service.create({ taskId: "t1", routeId: "r1" });
    manager.emit({ type: "output", taskId: "t1", routeId: "r1", ptyId: "pty_fake_1", data: "hello" });
    expect(send).toHaveBeenCalledWith(TerminalIpcChannels.terminalOutput, {
      taskId: "t1",
      routeId: "r1",
      ptyId: "pty_fake_1",
      data: "hello",
    });
  });

  it("forwards exit events on terminal:exit with the identity triple", async () => {
    const { service } = buildService();
    await service.create({ taskId: "t1", routeId: "r1" });
    manager.emit({ type: "exit", taskId: "t1", routeId: "r1", ptyId: "pty_fake_1", exitCode: 0 });
    expect(send).toHaveBeenCalledWith(TerminalIpcChannels.terminalExit, {
      taskId: "t1",
      routeId: "r1",
      ptyId: "pty_fake_1",
      exitCode: 0,
    });
  });
});
