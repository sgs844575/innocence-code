import { spawn, type ChildProcess } from "node:child_process";

export interface StdioServerOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 60_000;

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
  onExit: (() => void) | undefined;

  constructor(private readonly options: StdioServerOptions) {}

  get isExited(): boolean {
    return this.exited;
  }

  async start(): Promise<void> {
    this.proc = spawn(this.options.command, this.options.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env ?? {}) },
      windowsHide: true,
      shell: false,
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

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      if (this.exited || !this.proc?.stdin) {
        reject(new Error("MCP 服务器不可用"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  stop(): void {
    this.proc?.kill();
  }

  private send(msg: unknown): void {
    const stdin = this.proc?.stdin;
    if (!stdin) return;
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
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message ?? "MCP 错误"));
      else pending.resolve(msg.result);
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
