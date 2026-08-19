import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createExecutionScope,
  sha256Hex,
  PluginRegistry,
  type ToolContext,
} from "@innocencecode/harness-core";
import { StdioJsonRpcClient, mcpPlugin } from "../src";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "echo-server.mjs",
);

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

const ctx = (signal?: AbortSignal): ToolContext => ({
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
    // The plain fixture exits on stdin EOF, so dispose must not burn the
    // full force-kill grace window (>2s) before the process is gone.
    expect(elapsed).toBeLessThan(1_500);

    await expect(c.dispose()).resolves.toBeUndefined(); // idempotent — no throw
    await waitGone([pid!]);
    expect(c.isExited).toBe(true);
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
    const reg = new PluginRegistry();
    await reg.load([
      mcpPlugin({ servers: { echo: { command: process.execPath, args: [fixture] } } }),
    ]);
    const tool = reg.tools.get("mcp__echo__slow")!;
    const controller = new AbortController();
    const promise = tool.execute({ text: "x" }, ctx(controller.signal));
    setTimeout(() => controller.abort(), 100);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await reg.dispose();
  });
});

describe("mcpPlugin", () => {
  it("maps server tools as mcp__server__tool and executes calls end-to-end", async () => {
    const reg = new PluginRegistry();
    await reg.load([
      mcpPlugin({ servers: { echo: { command: process.execPath, args: [fixture] } } }),
    ]);
    const tool = reg.tools.get("mcp__echo__echo");
    expect(tool).toBeDefined();
    expect(tool!.readOnly).toBe(false);
    expect(tool!.sideEffect).toBe("unknown"); // 外部服务器能力未知，按最保守处理
    const result = await tool!.execute({ text: "hello" }, ctx());
    expect(result.content).toBe("echo: hello");
    expect(result.isError).toBeFalsy();
    await reg.dispose();
  });

  it("persists server/tool, parameter names and an args hash — never arg values", async () => {
    const reg = new PluginRegistry();
    await reg.load([
      mcpPlugin({ servers: { echo: { command: process.execPath, args: [fixture] } } }),
    ]);
    const tool = reg.tools.get("mcp__echo__echo")!;
    const SECRET = "MCP-PLUGIN-SECRET-77aa1";
    const resource = tool.permissionResource({ text: SECRET }, ctx());
    expect(resource).toEqual({ action: "call", kind: "mcp", scope: "echo/echo" });

    const persisted = tool.persistArgs({ text: SECRET, extra: 1 });
    expect(persisted).toEqual({
      server: "echo",
      tool: "echo",
      params: ["extra", "text"],
      argsSha256: sha256Hex(JSON.stringify({ text: SECRET, extra: 1 }, ["extra", "text"])),
    });
    expect(JSON.stringify(persisted)).not.toContain(SECRET);
    await reg.dispose();
  });

  it("skips unreachable servers without failing activation", async () => {
    const warnings: string[] = [];
    const reg = new PluginRegistry();
    await reg.load([
      {
        name: "capture",
        activate: (c) => {
          void c;
        },
      },
      mcpPlugin({
        servers: {
          missing: { command: "definitely-not-a-real-command-xyz", args: [] },
        },
      }),
    ]);
    // registry still usable, no tools from the missing server
    expect([...reg.tools.keys()].filter((k) => k.startsWith("mcp__"))).toEqual([]);
    void warnings;
    await reg.dispose();
  });

  it("dispose releases every stdio server's whole process tree", async () => {
    const reg = new PluginRegistry();
    // HOLD servers ignore stdin close, so disposal must take the force-kill
    // tree branch (Windows taskkill /T /F, POSIX process-group kill).
    const server = () => ({
      command: process.execPath,
      args: [fixture],
      env: { MCP_FIXTURE_HOLD: "1" },
    });
    await reg.load([mcpPlugin({ servers: { echo: server(), second: server() } })]);

    const pids: number[] = [];
    for (const name of ["echo", "second"]) {
      const result = await reg.tools.get(`mcp__${name}__tree`)!.execute({}, ctx());
      const match = result.content.match(/parent=(\d+) child=(\d+)/);
      expect(match).toBeDefined();
      pids.push(Number(match![1]), Number(match![2]));
    }
    expect(pids.length).toBe(4);

    await reg.dispose();
    await waitGone(pids); // both servers AND their spawned children are gone
  }, 25_000);
});
