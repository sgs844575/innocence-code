// Terminal IPC — the main-process surface for route-bound terminals (Task 9).
//
// Electron-free by construction (mirrors taskIpcHandlers.ts): the service
// validates renderer DTOs, resolves the cwd from the task runtime bridge's
// route handle (the renderer NEVER passes a path — only taskId/routeId), and
// pushes output/exit events to the renderer through an injected send port.
// registerTerminalIpc() is the only Electron touchpoint and is imported
// lazily so this module stays loadable in Node tests.
import { createPtyManager, type PtyEvent, type PtyManager } from "@innocencecode/terminal-pty";
import {
  TerminalIpcChannels,
  type TerminalCreateRequest,
  type TerminalCreateResponse,
  type TerminalDisposeRequest,
  type TerminalResizeRequest,
  type TerminalWriteRequest,
} from "../shared/terminalIpc";

// Same id discipline as the task bridge: single safe storage-directory
// segment — rejects absolute paths, traversal, drive letters, separators.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertId(value: unknown, field: "taskId" | "routeId" | "ptyId"): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new Error(`terminal ipc: unsafe ${field}: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertDimension(value: unknown, field: "cols" | "rows"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 2 || value > 500) {
    throw new Error(`terminal ipc: invalid ${field}: ${JSON.stringify(value)}`);
  }
  return value;
}

export interface TerminalIpcService {
  create(request: TerminalCreateRequest): Promise<TerminalCreateResponse>;
  write(request: TerminalWriteRequest): Promise<void>;
  resize(request: TerminalResizeRequest): Promise<void>;
  dispose(request: TerminalDisposeRequest): Promise<void>;
  /** App quit path: kills every shell tree. Never rejects. */
  disposeAll(): Promise<void>;
}

export interface TerminalIpcDeps {
  /**
   * Authoritative route workspace root from the task runtime bridge's route
   * handle. Returning undefined means "no live task/route" -> create rejects.
   */
  resolveRouteCwd(taskId: string, routeId: string): string | undefined;
  /** Renderer push port (webContents.send wrapper for the main window). */
  send(channel: string, payload: unknown): void;
  /** Manager factory override (tests); defaults to the real node-pty manager. */
  createManager?: (onEvent: (event: PtyEvent) => void) => PtyManager;
}

export function createTerminalIpcService(deps: TerminalIpcDeps): TerminalIpcService {
  const forward = (event: PtyEvent): void => {
    if (event.type === "output") {
      deps.send(TerminalIpcChannels.terminalOutput, {
        taskId: event.taskId,
        routeId: event.routeId,
        ptyId: event.ptyId,
        data: event.data,
      });
    } else {
      deps.send(TerminalIpcChannels.terminalExit, {
        taskId: event.taskId,
        routeId: event.routeId,
        ptyId: event.ptyId,
        exitCode: event.exitCode,
      });
    }
  };

  const manager: PtyManager =
    deps.createManager?.(forward) ?? createPtyManager({ onEvent: forward });

  /** Resolves the live session and rejects stale ptyIds in one step. */
  function liveSession(request: { taskId: unknown; routeId: unknown; ptyId: unknown }) {
    const taskId = assertId(request.taskId, "taskId");
    const routeId = assertId(request.routeId, "routeId");
    const ptyId = assertId(request.ptyId, "ptyId");
    const session = manager.get(taskId, routeId);
    if (!session || session.ptyId !== ptyId) {
      throw new Error(`terminal ipc: no live pty ${ptyId} for task ${taskId} route ${routeId}`);
    }
    return session;
  }

  return {
    async create(request) {
      const taskId = assertId(request?.taskId, "taskId");
      const routeId = assertId(request?.routeId, "routeId");
      const cwd = deps.resolveRouteCwd(taskId, routeId);
      if (!cwd) {
        throw new Error(`terminal ipc: unknown task/route: ${taskId}/${routeId}`);
      }
      const cols = request?.cols === undefined ? 80 : assertDimension(request.cols, "cols");
      const rows = request?.rows === undefined ? 24 : assertDimension(request.rows, "rows");
      const session = await manager.create({ taskId, routeId, cwd, cols, rows });
      return { taskId, routeId, ptyId: session.ptyId };
    },

    async write(request) {
      const session = liveSession(request);
      if (typeof request?.data !== "string") {
        throw new Error("terminal ipc: write requires string data");
      }
      session.write(request.data);
    },

    async resize(request) {
      const session = liveSession(request);
      const cols = assertDimension(request?.cols, "cols");
      const rows = assertDimension(request?.rows, "rows");
      session.resize(cols, rows);
    },

    async dispose(request) {
      const taskId = assertId(request?.taskId, "taskId");
      const routeId = assertId(request?.routeId, "routeId");
      const ptyId = assertId(request?.ptyId, "ptyId");
      const session = manager.get(taskId, routeId);
      if (session && session.ptyId !== ptyId) {
        // Stale renderer state must not kill a newer terminal on that route.
        throw new Error(`terminal ipc: stale ptyId ${ptyId} for task ${taskId} route ${routeId}`);
      }
      await manager.disposeForRoute(taskId, routeId);
    },

    async disposeAll() {
      await manager.disposeAll();
    },
  };
}

/**
 * Registers the ipcMain handlers. Dynamic import keeps this module loadable
 * in Node (vitest) — only the Electron host calls this function.
 */
export async function registerTerminalIpc(service: TerminalIpcService): Promise<void> {
  const { ipcMain } = await import("electron");
  ipcMain.handle(TerminalIpcChannels.terminalCreate, (_e, req) => service.create(req));
  ipcMain.handle(TerminalIpcChannels.terminalWrite, (_e, req) => service.write(req));
  ipcMain.handle(TerminalIpcChannels.terminalResize, (_e, req) => service.resize(req));
  ipcMain.handle(TerminalIpcChannels.terminalDispose, (_e, req) => service.dispose(req));
}
