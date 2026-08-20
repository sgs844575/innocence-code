// Terminal IPC channels and DTOs — the renderer-facing contract for the
// route-bound terminal (Task 9). Mirrors taskIpc.ts conventions:
//   - Renderer requests carry ONLY taskId/routeId/ptyId (+ input text or
//     cols/rows) — never absolute paths. The main process resolves the cwd
//     from the task runtime bridge's route handle.
//   - Main -> renderer output/exit events carry the full identity triple.

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export const TerminalIpcChannels = {
  terminalCreate: "terminal:create",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalDispose: "terminal:dispose",
  /** Main -> renderer: shell output bytes. */
  terminalOutput: "terminal:output",
  /** Main -> renderer: the shell process tree exited. */
  terminalExit: "terminal:exit",
} as const;

// ---------------------------------------------------------------------------
// Request / Response DTOs per channel
// ---------------------------------------------------------------------------

export interface TerminalCreateRequest {
  taskId: string;
  routeId: string;
  /** Initial grid size (xterm dimensions); omitted -> 80x24. */
  cols?: number;
  rows?: number;
}

export interface TerminalCreateResponse {
  taskId: string;
  routeId: string;
  ptyId: string;
}

export interface TerminalWriteRequest {
  taskId: string;
  routeId: string;
  ptyId: string;
  /** Keystrokes to feed the shell. */
  data: string;
}

export interface TerminalResizeRequest {
  taskId: string;
  routeId: string;
  ptyId: string;
  cols: number;
  rows: number;
}

export interface TerminalDisposeRequest {
  taskId: string;
  routeId: string;
  ptyId: string;
}

// ---------------------------------------------------------------------------
// Main -> renderer events
// ---------------------------------------------------------------------------

export interface TerminalOutputEvent {
  taskId: string;
  routeId: string;
  ptyId: string;
  data: string;
}

export interface TerminalExitEvent {
  taskId: string;
  routeId: string;
  ptyId: string;
  exitCode: number | null;
}

// ---------------------------------------------------------------------------
// Renderer-callable API surface (typed; the preload bridge implements it)
// ---------------------------------------------------------------------------

export interface TerminalIpcApi {
  create(request: TerminalCreateRequest): Promise<TerminalCreateResponse>;
  write(request: TerminalWriteRequest): Promise<void>;
  resize(request: TerminalResizeRequest): Promise<void>;
  dispose(request: TerminalDisposeRequest): Promise<void>;
  onTerminalOutput(cb: (e: TerminalOutputEvent) => void): () => void;
  onTerminalExit(cb: (e: TerminalExitEvent) => void): () => void;
}
