import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PluginRegistry, type ToolContext } from "@innocencecode/harness-core";
import { StdioJsonRpcClient, mcpPlugin } from "../src";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "echo-server.mjs",
);

let client: StdioJsonRpcClient;
beforeAll(async () => {
  client = new StdioJsonRpcClient({ command: process.execPath, args: [fixture] });
  await client.start();
});
afterAll(() => {
  client.stop();
});

const ctx = (): ToolContext => ({
  workspaceRoot: "D:/tmp",
  signal: new AbortController().signal,
  log: () => {},
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

describe("mcpPlugin", () => {
  it("maps server tools as mcp__server__tool and executes calls end-to-end", async () => {
    const reg = new PluginRegistry();
    await reg.load([
      mcpPlugin({ servers: { echo: { command: process.execPath, args: [fixture] } } }),
    ]);
    const tool = reg.tools.get("mcp__echo__echo");
    expect(tool).toBeDefined();
    expect(tool!.readOnly).toBe(false);
    const result = await tool!.execute({ text: "hello" }, ctx());
    expect(result.content).toBe("echo: hello");
    expect(result.isError).toBeFalsy();
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
  });
});
