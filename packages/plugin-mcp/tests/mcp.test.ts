import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@innocencecode/kernel";
import { LoggerPlugin } from "@innocencecode/kernel-logger";
import { ToolsPlugin } from "@innocencecode/harness-tools";
import {
  createExecutionScope,
  sha256Hex,
  type ToolContext,
} from "@innocencecode/harness-core";
import { StdioJsonRpcClient, createMcpPlugin, type StdioServerOptions } from "../src";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "echo-server.mjs",
);

/** Mounts the plugin on a bare kernel context (logger + tools spine); the
 *  plugin fiber's unwind (ctx.fiber.dispose) replaces the old registry dispose. */
async function mountMcp(servers: Record<string, StdioServerOptions>): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(LoggerPlugin);
  await ctx.plugin(ToolsPlugin);
  await ctx.plugin(createMcpPlugin({ servers }));
  return ctx;
}

/** Polls process.kill(pid, 0) until every pid is gone (process tree exited). */
async function waitGone(pids: number[], timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) return;
    if (Date.now() > deadline) throw new Error(`进程仍然存活: ${alive.join(", ")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

let client: StdioJsonRpcClient;
beforeAll(async () => {
  client = new StdioJsonRpcClient({ command: process.execPath, args: [fixture] });
  await client.start();
});
afterAll(async () => {
  await client.dispose();
});

const ctxToolContext = (signal?: AbortSignal): ToolContext => ({
  workspaceRoot: "D:/tmp",
  signal: signal ?? new AbortController().signal,
  log: () => {},
  scope: createExecutionScope("mcp__echo__echo"),
});

describe("StdioJsonRpcClient", () => {
  it("round-trips requests against the fixture server", async () => {
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    });
    expect((init as { serverInfo?: { name?: string } }).serverInfo?.name).toBe(
      "echo-fixture",
    );
    const list = await client.request<{ tools?: Array<{ name: string }> }>("tools/list", {});
    expect(list.tools?.[0]?.name).toBe("echo");
    const call = await client.request<{ content?: Array<{ text?: string }> }>("tools/call", {
      name: "echo",
      arguments: { text: "你好" },
    });
    expect(call.content?.[0]?.text).toBe("echo: 你好");
  });

  it("rejects with the server's error message", async () => {
    await expect(client.request("nope")).rejects.toThrow("unknown: nope");
  });
});

describe("StdioJsonRpcClient dispose", () => {
  it("ends the server gracefully (no grace expiry) and is idempotent", async () => {
    const c = new StdioJsonRpcClient({ command: process.execPath, args: [fixture] });
    await c.start();
    const pid = c.pid;
    expect(pid).toBeGreaterThan(0);

    const started = Date.now();
    await c.dispose();
    const elapsed = Date.now() - started;
    // The plain fixture exits on stdin EOF, so dispose resolves within the
    // DISPOSE_GRACE_MS window (<2s) — the force-kill branch can only fire
    // AFTER the full grace elapses, so this bounds the graceful path.
    expect(elapsed).toBeLessThan(2_000);

    await expect(c.dispose()).resolves.toBeUndefined(); // idempotent — no throw
    await waitGone([pid!]);
    expect(c.isExited).toBe(true);
  });

  it("fails fast when a request arrives after dispose", async () => {
    const c = new StdioJsonRpcClient({ command: process.execPath, args: [fixture] });
    await c.start();
    await c.dispose();
    await expect(c.request("tools/list", {})).rejects.toThrow("MCP 客户端已释放");
  });

  it("force-kills the process tree when the server ignores stdin close", async () => {
    const c = new StdioJsonRpcClient({
      command: process.execPath,
      args: [fixture],
      env: { MCP_FIXTURE_HOLD: "1" },
    });
    await c.start();
    const pid = c.pid!;
    await c.dispose();
    // MCP_FIXTURE_HOLD keeps the server alive past stdin close: only the
    // taskkill /T /F (or POSIX group kill) branch can end it.
    await waitGone([pid]);
  }, 15_000);
});

describe("request abort signal", () => {
  it("sanitizes untrusted server error text (control chars + hard truncation)", async () => {
    const c = new StdioJsonRpcClient({ command: process.execPath, args: [fixture] });
    await c.start();
    const SECRET = `MCP-BOOM-SECRET-${"x".repeat(600)}`;
    const err = await c
      .request("tools/call", { name: "boom", arguments: { token: SECRET } })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    // The echoed secret never survives in full and the text is bounded.
    expect(message).not.toContain(SECRET);
    expect(message).toContain("[已截断");
    expect(message.length).toBeLessThanOrEqual(600);
    // Control characters from the hostile payload are stripped.
    expect(/[\u0000-\u001f\u007f]/.test(message)).toBe(false);
    await c.dispose();
  });

  it("aborts an in-flight request and notifies the server (notifications/cancelled)", async () => {
    const c = new StdioJsonRpcClient({ command: process.execPath, args: [fixture] });
    await c.start();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await expect(
      c.request("tools/call", { name: "slow", arguments: {} }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(5_000);

    const log = await c.request<{ content?: Array<{ text?: string }> }>("tools/call", {
      name: "cancel_log",
      arguments: {},
    });
    // The fixture recorded the cancelled request id (a positive number).
    const recorded = JSON.parse(log.content?.[0]?.text ?? "[]") as unknown[];
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    expect(recorded[0]).toEqual(expect.any(Number));
    expect(Date.now() - started).toBeLessThan(5_000);
    await c.dispose();
  });

  it("MCP tool execute rejects with an AbortError when ctx.signal aborts", async () => {
    const ctx = await mountMcp({ echo: { command: process.execPath, args: [fixture] } });
    const tool = ctx.tools.get("mcp__echo__slow")!;
    const controller = new AbortController();
    const promise = tool.execute({ text: "x" }, ctxToolContext(controller.signal));
    setTimeout(() => controller.abort(), 100);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await ctx.fiber.dispose();
  });

  it("server-echoed secrets are truncated out of isError tool results", async () => {
    const ctx = await mountMcp({ echo: { command: process.execPath, args: [fixture] } });
    const tool = ctx.tools.get("mcp__echo__boom")!;
    const SECRET = `MCP-BOOM-SECRET-${"y".repeat(600)}`;
    // The isError result is what history/audit persist — the echoed secret
    // must not survive intact past the client's trust boundary.
    const result = await tool.execute({ token: SECRET }, ctxToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("MCP 调用失败");
    expect(result.content).not.toContain(SECRET);
    expect(result.content).toContain("[已截断");
    await ctx.fiber.dispose();
  });
});

describe("createMcpPlugin", () => {
  it("maps server tools as mcp__server__tool and executes calls end-to-end", async () => {
    const ctx = await mountMcp({ echo: { command: process.execPath, args: [fixture] } });
    const tool = ctx.tools.get("mcp__echo__echo");
    expect(tool).toBeDefined();
    expect(tool!.readOnly).toBe(false);
    expect(tool!.sideEffect).toBe("unknown"); // 外部服务器能力未知，按最保守处理
    const result = await tool!.execute({ text: "hello" }, ctxToolContext());
    expect(result.content).toBe("echo: hello");
    expect(result.isError).toBeFalsy();
    await ctx.fiber.dispose();
  });

  it("persists server/tool, parameter names and an args hash — never arg values", async () => {
    const ctx = await mountMcp({ echo: { command: process.execPath, args: [fixture] } });
    const tool = ctx.tools.get("mcp__echo__echo")!;
    const SECRET = "MCP-PLUGIN-SECRET-77aa1";
    const resource = tool.permissionResource({ text: SECRET }, ctxToolContext());
    expect(resource).toEqual({ action: "call", kind: "mcp", scope: "echo/echo" });

    const persisted = tool.persistArgs({ text: SECRET, extra: 1 });
    expect(persisted).toEqual({
      server: "echo",
      tool: "echo",
      params: ["extra", "text"],
      argsSha256: sha256Hex(JSON.stringify({ text: SECRET, extra: 1 }, ["extra", "text"])),
    });
    expect(JSON.stringify(persisted)).not.toContain(SECRET);
    await ctx.fiber.dispose();
  });

  it("skips unreachable servers without failing activation", async () => {
    const ctx = await mountMcp({
      missing: { command: "definitely-not-a-real-command-xyz", args: [] },
    });
    // kernel still usable, no tools from the missing server
    expect(ctx.tools.specs().map((s) => s.name).filter((k) => k.startsWith("mcp__"))).toEqual([]);
    await ctx.fiber.dispose();
  });

  it("dispose releases every stdio server's whole process tree", async () => {
    // HOLD servers ignore stdin close, so disposal must take the force-kill
    // tree branch (Windows taskkill /T /F, POSIX process-group kill).
    const server = (): StdioServerOptions => ({
      command: process.execPath,
      args: [fixture],
      env: { MCP_FIXTURE_HOLD: "1" },
    });
    const ctx = await mountMcp({ echo: server(), second: server() });

    const pids: number[] = [];
    for (const name of ["echo", "second"]) {
      const result = await ctx.tools.get(`mcp__${name}__tree`)!.execute({}, ctxToolContext());
      const match = result.content.match(/parent=(\d+) child=(\d+)/);
      expect(match).toBeDefined();
      pids.push(Number(match![1]), Number(match![2]));
    }
    expect(pids.length).toBe(4);

    await ctx.fiber.dispose();
    await waitGone(pids); // both servers AND their spawned children are gone
  }, 25_000);
});
