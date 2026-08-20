// PtySession — one live pseudo-terminal bound to a task route. Events carry
// the full identity triple (taskId/routeId/ptyId) so downstream consumers
// (terminal IPC) never have to guess which route a byte belongs to.
import { spawn } from "node:child_process";
import { spawn as spawnPty, type IPty } from "node-pty";

/** Output bytes flowing from the shell to the consumer. */
export interface PtyOutputEvent {
  type: "output";
  taskId: string;
  routeId: string;
  ptyId: string;
  data: string;
}

/** The shell process (tree) is gone. */
export interface PtyExitEvent {
  type: "exit";
  taskId: string;
  routeId: string;
  ptyId: string;
  exitCode: number;
}

export type PtyEvent = PtyOutputEvent | PtyExitEvent;

export interface PtySession {
  readonly ptyId: string;
  readonly taskId: string;
  readonly routeId: string;
  readonly cwd: string;
  /** Sends input bytes (keystrokes) to the shell. */
  write(data: string): void;
  /** Resizes the pty (xterm fit-addon dimensions). */
  resize(cols: number, rows: number): void;
  /**
   * Resolves with the accumulated output (ANSI escapes stripped) once it has
   * settled — i.e. non-empty and quiet for a moment. Test and bootstrap aid;
   * live consumers subscribe through the manager's onEvent instead.
   */
  output(settleMs?: number): Promise<string>;
  /** Notifies when the shell exits (by itself or via dispose). */
  onExit(listener: (event: PtyExitEvent) => void): () => void;
  /**
   * Kills the shell PROCESS TREE and resolves after its exit event (never
   * rejects; a bounded timeout resolves anyway). Idempotent.
   */
  dispose(): Promise<void>;
}

export interface PtySessionInit {
  readonly ptyId: string;
  readonly taskId: string;
  readonly routeId: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
}

export interface LivePtySessionOptions {
  /** Emitted for every output chunk and the final exit. */
  readonly onEvent: (event: PtyEvent) => void;
  /** Called exactly once when the session ends (registry cleanup). */
  readonly onGone: () => void;
}

/** Windows shell trees survive a plain kill() — taskkill /T /F is mandatory. */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone — the exit handler still fires from node-pty.
    }
  }
}

/** Strips CSI/OSC escape sequences so path assertions match rendered text. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "");
}

const DISPOSE_TIMEOUT_MS = 5_000;
const OUTPUT_WAIT_MS = 10_000;

export class LivePtySession implements PtySession {
  readonly ptyId: string;
  readonly taskId: string;
  readonly routeId: string;
  readonly cwd: string;

  private readonly pty: IPty;
  private readonly options: LivePtySessionOptions;
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  private buffer = "";
  private lastDataAt = 0;
  private ended = false;
  private disposed = false;

  constructor(init: PtySessionInit, options: LivePtySessionOptions) {
    if (!init.cwd) throw new Error("pty: cwd is required");
    this.ptyId = init.ptyId;
    this.taskId = init.taskId;
    this.routeId = init.routeId;
    this.cwd = init.cwd;
    this.options = options;
    const shell =
      process.platform === "win32"
        ? (process.env.comspec || "cmd.exe")
        : (process.env.SHELL || "/bin/sh");
    this.pty = spawnPty(shell, [], {
      name: "xterm-256color",
      cwd: init.cwd,
      cols: init.cols,
      rows: init.rows,
      env: process.env as { [key: string]: string },
    });
    this.pty.onData((data) => {
      if (this.ended) return;
      this.buffer += data;
      this.lastDataAt = Date.now();
      this.options.onEvent({ type: "output", taskId: this.taskId, routeId: this.routeId, ptyId: this.ptyId, data });
    });
    this.pty.onExit(({ exitCode }) => {
      if (this.ended) return;
      this.ended = true;
      const event: PtyExitEvent = {
        type: "exit",
        taskId: this.taskId,
        routeId: this.routeId,
        ptyId: this.ptyId,
        exitCode,
      };
      this.options.onGone();
      this.options.onEvent(event);
      for (const listener of this.exitListeners) listener(event);
      this.exitListeners.clear();
    });
  }

  write(data: string): void {
    if (this.ended) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.ended) return;
    this.pty.resize(cols, rows);
  }

  async output(settleMs = 250): Promise<string> {
    const deadline = Date.now() + OUTPUT_WAIT_MS;
    for (;;) {
      if (this.buffer.length > 0 && Date.now() - this.lastDataAt >= settleMs) {
        return stripAnsi(this.buffer);
      }
      if (Date.now() >= deadline) return stripAnsi(this.buffer);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  onExit(listener: (event: PtyExitEvent) => void): () => void {
    if (this.ended) return () => {};
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ended) return;
    const sawExit = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), DISPOSE_TIMEOUT_MS);
      this.onExit(() => {
        clearTimeout(timer);
        resolve(true);
      });
      killTree(this.pty.pid);
    });
    if (!sawExit) {
      // Last resort when the tree kill raced: node-pty's own kill path.
      // (Skipped in the normal path — calling it on an already-dead conhost
      // makes node-pty's console-list agent crash with "AttachConsole failed".)
      try {
        this.pty.kill();
      } catch {
        // Already gone.
      }
    }
  }
}
