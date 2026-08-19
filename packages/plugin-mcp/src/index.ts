import {
  sha256Hex,
  type HarnessPlugin,
  type JsonSchema,
  type ToolResult,
} from "@innocencecode/harness-core";
import { StdioJsonRpcClient, type StdioServerOptions } from "./jsonrpc";

const PROTOCOL_VERSION = "2024-11-05";

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

interface McpCallResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

export interface McpPluginOptions {
  /** server name -> launch config; each server's tools become mcp__name__tool. */
  servers: Record<string, StdioServerOptions>;
}

interface ServerConnection {
  exited(): boolean;
  call(toolName: string, args: Record<string, unknown>): Promise<ToolResult>;
}

async function connect(
  serverName: string,
  options: StdioServerOptions,
  log: (level: "info" | "warn" | "error", msg: string) => void,
): Promise<{ tools: McpToolDef[]; connection: ServerConnection }> {
  const client = new StdioJsonRpcClient(options);
  await client.start();
  try {
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "innocencecode", version: "0.1.0" },
    });
    client.notify("notifications/initialized", {});
    const list = await client.request<{ tools?: McpToolDef[] }>("tools/list", {});
    const tools = (list.tools ?? []).filter((t) => typeof t.name === "string");
    log("info", `MCP ${serverName}: ${tools.length} 个工具`);
    return {
      tools,
      connection: {
        exited: () => client.isExited,
        call: async (toolName, args) => {
          const result = await client.request<McpCallResult>("tools/call", {
            name: toolName,
            arguments: args,
          });
          const text = (result.content ?? [])
            .map((c) => c.text ?? "")
            .filter(Boolean)
            .join("\n");
          return {
            content: text || "[MCP 工具无文本输出]",
            isError: result.isError === true,
          };
        },
      },
    };
  } catch (err) {
    client.stop();
    throw err;
  }
}

/**
 * MCP stdio client plugin. Failed servers log a warning and are skipped —
 * one bad server never blocks activation; crashed servers surface per-call
 * as error tool results.
 */
export const mcpPlugin = (options: McpPluginOptions): HarnessPlugin => ({
  name: "plugin-mcp",
  async activate(ctx) {
    for (const [serverName, serverOptions] of Object.entries(options.servers)) {
      let connected: Awaited<ReturnType<typeof connect>>;
      try {
        connected = await connect(serverName, serverOptions, (level, msg) =>
          ctx.log(level, msg),
        );
      } catch (err) {
        ctx.log(
          "warn",
          `MCP 服务器 ${serverName} 连接失败：${err instanceof Error ? err.message : err}`,
        );
        continue;
      }
      for (const def of connected.tools) {
        const toolName = `mcp__${serverName}__${def.name}`;
        try {
          ctx.registerTool({
            name: toolName,
            description: def.description ?? `MCP 工具 ${serverName}/${def.name}`,
            readOnly: false,
            sideEffect: "unknown", // 外部服务器能力未知，按最保守处理
            parameters: def.inputSchema ?? { type: "object" },
            // 资源只标识 server/tool；调用参数绝不进入资源。
            permissionResource: () => ({
              action: "call",
              kind: "mcp",
              scope: `${serverName}/${def.name}`,
            }),
            // 保存 server/tool、参数名和参数哈希，不保存参数值。
            persistArgs: (args) => {
              const keys = Object.keys(args).sort();
              return {
                server: serverName,
                tool: def.name,
                params: keys,
                argsSha256: sha256Hex(JSON.stringify(args, keys)),
              };
            },
            execute: async (args) => {
              if (connected.connection.exited()) {
                return {
                  content: `MCP 服务器 ${serverName} 已退出，工具 ${def.name} 不可用`,
                  isError: true,
                };
              }
              try {
                return await connected.connection.call(def.name, args);
              } catch (err) {
                return {
                  content: `MCP 调用失败：${err instanceof Error ? err.message : err}`,
                  isError: true,
                };
              }
            },
          });
        } catch {
          // duplicate tool name — first registration wins
        }
      }
    }
  },
});

export { StdioJsonRpcClient } from "./jsonrpc";
export type { StdioServerOptions } from "./jsonrpc";
