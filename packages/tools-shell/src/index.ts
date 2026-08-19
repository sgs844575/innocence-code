import { spawn, type ChildProcess } from "node:child_process";
import {
  redactCommand,
  sha256Hex,
  type HarnessPlugin,
  type Tool,
  type ToolContext,
} from "@innocencecode/harness-core";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;

/** Kills the whole process tree — shell:true spawns a wrapper shell whose
 *  children survive a plain kill() on Windows. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child.kill("SIGKILL");
  }
}

export interface RunCommandOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputChars?: number;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Runs a shell command with timeout, abort and truncated capture. */
export function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  const { command, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;
  const max = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const isWindows = process.platform === "win32";
  const child = spawn(command, {
    shell: true,
    cwd,
    windowsHide: true,
    env: { ...process.env, ...(isWindows ? {} : { shell: "/bin/sh" }) },
  });

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const capture = (kind: "stdout" | "stderr", chunk: string) => {
      const total = stdout.length + stderr.length;
      if (total >= max) return;
      const room = max - total;
      const text = chunk.length > room ? `${chunk.slice(0, room)}…[已截断]` : chunk;
      if (kind === "stdout") stdout += text;
      else stderr += text;
    };

    child.stdout?.on("data", (d: Buffer) => capture("stdout", d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => capture("stderr", d.toString("utf8")));

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, exitCode, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const onAbort = () => {
      timedOut = false;
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      stderr += `spawn 失败：${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/** Bash-like shell tool: runs commands in the workspace root. */
export const bashTool: Tool = {
  name: "Bash",
  description:
    "在工作区目录执行 shell 命令（Windows 用 cmd，其他平台用 sh）。适合跑测试、构建、装依赖。" +
    "输出超长会截断；命令有超时上限。失败时读取 stderr 自行修正。",
  readOnly: false,
  sideEffect: "process",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
      timeoutMs: { type: "integer", description: "超时毫秒数（可选，默认 120000）" },
    },
    required: ["command"],
  },
  async validateArgs(args) {
    const command = args.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error("缺少必填参数 command（字符串）");
    }
  },
  permissionResource(args) {
    // 资源 scope 只含程序词；完整命令绝不进入资源。
    return {
      action: "execute",
      kind: "command",
      scope: redactCommand(String(args.command ?? "")),
    };
  },
  persistArgs(args) {
    const command = requireCommand(args);
    // 保存脱敏命令摘要（程序词）和命令哈希，不保存完整命令。
    return {
      command: redactCommand(command),
      commandSha256: sha256Hex(command),
    };
  },
  async execute(args, ctx: ToolContext) {
    const command = requireCommand(args);
    const result = await runCommand({
      command,
      cwd: ctx.workspaceRoot,
      timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
      signal: ctx.signal,
    });
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    if (result.timedOut) parts.push(`[命令超时被终止（>${Math.round((typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_TIMEOUT_MS) / 1000)}s）]`);
    const ok = !result.timedOut && result.exitCode === 0;
    return {
      content: parts.join("\n") || "[无输出，退出码 0]",
      isError: !ok,
    };
  },
};

function requireCommand(args: Record<string, unknown>): string {
  const command = args.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("缺少必填参数 command（字符串）");
  }
  return command;
}

export const shellPlugin: HarnessPlugin = {
  name: "tools-shell",
  activate(ctx) {
    ctx.registerTool(bashTool);
  },
};
