// Minimal MCP stdio server used as a test fixture: newline-delimited
// JSON-RPC with initialize / tools/list / tools/call and one echo tool.
// Extra tools cover client lifecycle tests: `slow` delays its response,
// `tree` spawns a long-lived grandchild and reports both PIDs, `cancel_log`
// reports received notifications/cancelled request ids. MCP_FIXTURE_HOLD=1
// keeps the process alive after stdin close, so only a force kill ends it.
import { spawn } from "node:child_process";
import readline from "node:readline";

const cancelled = [];
let grandchild = null;

if (process.env.MCP_FIXTURE_HOLD === "1") {
  setInterval(() => {}, 1000);
}

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "notifications/cancelled") {
    cancelled.push(msg.params?.requestId ?? null);
    return;
  }
  if (typeof msg.id !== "number") return;
  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "echo-fixture", version: "1.0.0" },
        },
      });
      break;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "原样返回输入文本",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
            {
              name: "slow",
              description: "30 秒后才回应（用于取消测试）",
              inputSchema: { type: "object" },
            },
            {
              name: "tree",
              description: "派生长驻子进程并报告进程树 PID",
              inputSchema: { type: "object" },
            },
            {
              name: "cancel_log",
              description: "返回收到的取消通知 requestId 列表",
              inputSchema: { type: "object" },
            },
            {
              name: "boom",
              description: "回显调用参数的错误响应（验证客户端对不可信错误文本的截断清理）",
              inputSchema: { type: "object" },
            },
          ],
        },
      });
      break;
    case "tools/call": {
      const name = msg.params?.name;
      if (name === "crash") {
        process.exit(1);
      }
      if (name === "slow") {
        const id = msg.id;
        setTimeout(() => {
          send({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: "slow: done" }] },
          });
        }, 30_000);
        return;
      }
      if (name === "tree") {
        if (!grandchild) {
          grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
          });
        }
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: `parent=${process.pid} child=${grandchild.pid}` }],
          },
        });
        return;
      }
      if (name === "cancel_log") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: JSON.stringify(cancelled) }] },
        });
        return;
      }
      if (name === "boom") {
        // Hostile-server shape: echoes the raw argument (secrets included)
        // into the error message, padded with control characters.
        const token = msg.params?.arguments?.token ?? "";
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: `boom: \u0000\u001f${token}` },
        });
        return;
      }
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: `echo: ${msg.params?.arguments?.text ?? ""}` }],
        },
      });
      break;
    }
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown: ${msg.method}` } });
  }
});
