import type { Context } from "@innocencecode/kernel";
import {
  isAbortError,
  sha256Hex,
  type JsonSchema,
  type ToolResult,
} from "@innocencecode/harness-tools";
import { StdioJsonRpcClient, type StdioServerOptions } from "./jsonrpc";

// ctx.logger 的类型可见性：kernel-logger 不自带 Context 增强，这里按
// session 组合侧（harness-core/session-kernel）的同一声明就地合并（成员
// 类型逐字一致，同程序内合并合法），包自身不再依赖 harness-core。
declare module "@innocencecode/kernel" {
  interface Context {
    logger: import("@innocencecode/kernel-logger").LoggerService;
  }
}

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
  call(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
}

async function connect(
  serverName: string,
  options: StdioServerOptions,
  log: (level: "info" | "warn" | "error", msg: string) => void,
): Promise<{
  client: StdioJsonRpcClient;
  tools: McpToolDef[];
  connection: ServerConnection;
}> {
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
      client,
      tools,
      connection: {
        exited: () => client.isExited,
        call: async (toolName, args, signal) => {
          const result = await client.request<McpCallResult>(
            "tools/call",
            { name: toolName, arguments: args },
            { signal },
          );
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

/** Kernel-native MCP plugin (name "mcp"). */
export interface McpPlugin {
  readonly name: "mcp";
  apply(ctx: Context): Promise<void>;
}

/**
 * MCP stdio client plugin. Failed servers log a warning and are skipped —
 * one bad server never blocks activation; crashed servers surface per-call
 * as error tool results. Unloading the plugin releases every stdio client
 * it started (fiber effect): plugin unload stops the subprocesses.
 */
export function createMcpPlugin(options: McpPluginOptions): McpPlugin {
  const clients: StdioJsonRpcClient[] = [];
  /**
   * Releases every stdio client in parallel; one stuck server must not
   * block the others (each dispose is itself time-bounded).
   */
  const release = async (): Promise<void> => {
    await Promise.allSettled(clients.map((client) => client.dispose()));
    clients.length = 0;
  };
  return {
    name: "mcp",
    async apply(ctx) {
      for (const [serverName, serverOptions] of Object.entries(options.servers)) {
        let connected: Awaited<ReturnType<typeof connect>>;
        try {
          connected = await connect(serverName, serverOptions, (level, msg) =>
            ctx.logger.log(level, `[mcp] ${msg}`),
          );
        } catch (err) {
          ctx.logger.log(
            "warn",
            `[mcp] MCP 服务器 ${serverName} 连接失败：${err instanceof Error ? err.message : err}`,
          );
          continue;
        }
        clients.push(connected.client);
        for (const def of connected.tools) {
          const toolName = `mcp__${serverName}__${def.name}`;
          try {
            ctx.tools.register({
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
              execute: async (args, ctx) => {
                if (connected.connection.exited()) {
                  return {
                    content: `MCP 服务器 ${serverName} 已退出，工具 ${def.name} 不可用`,
                    isError: true,
                  };
                }
                try {
                  // The executor's derived signal (timeout / user stop) rides
                  // into tools/call and cancels the server-side work.
                  return await connected.connection.call(def.name, args, ctx.signal);
                } catch (err) {
                  if (isAbortError(err)) throw err; // let the executor stamp "aborted"
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
      // Registered after a successful activation, so a failed apply never
      // triggers cleanup (the legacy dispose-after-activate semantics).
      ctx.effect(() => release, "mcp stdio clients");
    },
  };
}

export { StdioJsonRpcClient } from "./jsonrpc";
export type { StdioServerOptions } from "./jsonrpc";
// Distribution default (kernel-loader unwrapExports convention): the factory,
// so a disk-loaded module resolves to the single entry point hosts configure.
export default createMcpPlugin;
