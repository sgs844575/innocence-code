import { spawn, type ChildProcess } from "node:child_process";

export interface StdioServerOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** Per-request options. */
export interface RequestOptions {
  /**
   * Aborting rejects the request with an AbortError and best-effort notifies
   * the server via `notifications/cancelled`, so it can stop the work.
   */
  signal?: AbortSignal;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Clears the timeout and detaches the abort listener. */
  detach: () => void;
}

const REQUEST_TIMEOUT_MS = 60_000;
/** How long dispose waits after stdin close before force-killing the tree. */
const DISPOSE_GRACE_MS = 2_000;
/** How long dispose waits after the force kill for the exit event. */
const FORCE_KILL_WAIT_MS = 5_000;

function requestAbortedError(method: string): Error {
  const err = new Error(`MCP 请求已中止：${method}`);
  err.name = "AbortError";
  return err;
}

/**
 * Kills the whole process tree: `taskkill /T /F` on Windows (a plain kill
 * leaves the wrapper shell's children alive), process-group SIGKILL on POSIX
 * (the server is spawned detached, so it leads its own group).
 */
function killTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL"); // group already gone — kill the leader directly
    }
  }
}

/**
 * Minimal JSON-RPC 2.0 client over newline-delimited stdio (the MCP stdio
 * transport framing). One response per request id; notifications are fire
 * and forget.
 */
export class StdioJsonRpcClient {
  private proc: ChildProcess | undefined;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private exited = false;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  onExit: (() => void) | undefined;

  constructor(private readonly options: StdioServerOptions) {}

  get isExited(): boolean {
    return this.exited;
  }

  /** OS pid of the spawned server (undefined before a successful start). */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  async start(): Promise<void> {
    this.proc = spawn(this.options.command, this.options.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env ?? {}) },
      windowsHide: true,
      shell: false,
      // Own process group on POSIX, so dispose can tree-kill via kill(-pid).
      detached: process.platform !== "win32",
    });
    this.proc.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr?.on("data", () => {}); // keep the pipe draining
    this.proc.on("error", (err) => this.failAll(new Error(`启动失败：${err.message}`)));
    this.proc.on("exit", () => {
      this.exited = true;
      this.failAll(new Error("MCP 服务器进程已退出"));
      this.onExit?.();
    });
    // Probe liveness: a spawn error (missing command) surfaces on next tick.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        this.proc?.removeListener("error", onSpawnError);
        resolve();
      }, 0);
      const onSpawnError = (err: Error) => {
        clearTimeout(t);
        reject(err);
      };
      this.proc?.once("error", onSpawnError);
    });
    if (this.exited) throw new Error("MCP 服务器进程启动后立即退出");
  }

  request<T>(method: string, params?: unknown, options?: RequestOptions): Promise<T> {
    const id = ++this.nextId;
    const signal = options?.signal;
    return new Promise<T>((resolve, reject) => {
      if (this.disposed || this.exited || !this.proc?.stdin) {
        reject(new Error(this.disposed ? "MCP 客户端已释放" : "MCP 服务器不可用"));
        return;
      }
      if (signal?.aborted) {
        reject(requestAbortedError(method));
        return;
      }
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        // Best-effort MCP cancellation notice; stdin may already be closed.
        this.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "client aborted" },
        });
        reject(requestAbortedError(method));
      };
      const detach = () => signal?.removeEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        detach();
        reject(new Error(`MCP 请求超时：${method}`));
      }, REQUEST_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        detach,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /**
   * Graceful, idempotent teardown: closes stdin first (well-behaved servers
   * exit on EOF and pending responses still drain within the grace window),
   * then force-kills the whole process tree — `taskkill /T /F` on Windows,
   * process-group SIGKILL on POSIX. Repeated calls return the same promise.
   */
  dispose(): Promise<void> {
    this.disposed = true;
    this.disposePromise ??= this.doDispose();
    return this.disposePromise;
  }

  private async doDispose(): Promise<void> {
    const proc = this.proc;
    if (proc && !this.exited) {
      try {
        proc.stdin?.end();
      } catch {
        // stdin already destroyed — the exit wait below still applies
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, DISPOSE_GRACE_MS);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (!this.exited) await this.killTreeAndWait(proc);
    }
    this.failAll(new Error("MCP 客户端已释放"));
  }

  /** Waits for the exit event after a tree kill, bounded by FORCE_KILL_WAIT_MS. */
  private killTreeAndWait(proc: ChildProcess): Promise<void> {
    if (proc.pid === undefined) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, FORCE_KILL_WAIT_MS);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      killTree(proc);
    });
  }

  /** Synchronous last-resort kill for activation-rollback paths. */
  stop(): void {
    const proc = this.proc;
    if (proc && !this.exited) killTree(proc);
    this.failAll(new Error("MCP 客户端已停止"));
  }

  private send(msg: unknown): void {
    const stdin = this.proc?.stdin;
    // Guard the write-after-end race during/after dispose: writing an ended
    // stream emits an async 'error' nobody listens for, crashing the host.
    if (!stdin || stdin.destroyed || stdin.writableEnded) return;
    stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // tolerate server log noise on stdout
      }
      if (typeof msg.id !== "number") continue; // notifications from server
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      pending.detach();
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message ?? "MCP 错误"));
      else pending.resolve(msg.result);
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      p.detach();
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
