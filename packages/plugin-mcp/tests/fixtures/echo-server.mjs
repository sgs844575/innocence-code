// Minimal MCP stdio server used as a test fixture: newline-delimited
// JSON-RPC with initialize / tools/list / tools/call and one echo tool.
import readline from "node:readline";

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
          ],
        },
      });
      break;
    case "tools/call":
      if (msg.params?.name === "crash") {
        process.exit(1);
      }
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: `echo: ${msg.params?.arguments?.text ?? ""}` }],
        },
      });
      break;
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown: ${msg.method}` } });
  }
});
