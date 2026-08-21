# plugin-mcp — MCP stdio 客户端插件

`@innocencecode/plugin-mcp` 按配置拉起外部 MCP（Model Context Protocol）服务器的 stdio 子进程，
完成 JSON-RPC 握手后把每个服务器工具注册进 harness，工具名为 `mcp__<server>__<tool>`。
自包含一个最小 JSON-RPC 2.0 over 换行分隔 stdio 客户端（`StdioJsonRpcClient`），不依赖任何 MCP SDK。

## 作用

- **服务器接入**：`initialize`（协议版本 `2024-11-05`）→ `notifications/initialized` → `tools/list`，随后逐工具注册。
- **工具映射**：每个 MCP 工具变成一个普通 harness 工具，走统一审批；`sideEffect: "unknown"`（外部能力未知，按最保守处理）。
- **权限与脱敏**：资源只标识 `server/tool`，调用参数绝不进入资源；持久化只保存参数名与参数哈希，不保存参数值。
- **生命周期**：单个服务器连接失败仅告警并跳过，绝不阻塞其他服务器激活；崩溃的服务器按调用返回 `isError` 工具结果；
  插件卸载（fiber effect）并行释放全部 stdio 客户端。

## 公开 API

| 导出 | 说明 |
|---|---|
| `createMcpPlugin(options)` | 构造内核原生插件（name `mcp`，`apply(ctx)`）；`options.servers: Record<string, StdioServerOptions>` |
| `StdioJsonRpcClient` | stdio JSON-RPC 客户端：`start / request / notify / dispose / stop`，getter `isExited / pid` |
| `StdioServerOptions` | `{ command, args?, env?, cwd? }`（env 与 process.env 合并） |

## 使用

项目配置（`.innocence/config.json`，由宿主组合根读取后注入）：

```json
{
  "mcpServers": {
    "example": { "command": "npx", "args": ["-y", "some-mcp-server"] }
  }
}
```

宿主接线（`src/main/harnessGlue.ts`）：

```ts
import { createMcpPlugin } from "@innocencecode/plugin-mcp";

// config 来自 loadInnocenceConfig(workspaceRoot)
plugins.push(createMcpPlugin({ servers: config.mcpServers ?? {} }));
// 之后模型即可调用 mcp__example__工具名，默认走审批
```

该插件在插件开关里的 id 是 `mcp`，可被用户/项目层开关关闭（解析逻辑在宿主侧 `src/main/plugin-toggles-local.ts` 的 `resolvePluginSet`）。

## 关键行为与约束

- 请求超时 60s，支持 `AbortSignal`（中止时尽力发送 `notifications/cancelled`，执行器的超时/用户停止信号会传导到服务器端）。
- 关停顺序：stdin.end → 等 exit（2s 宽限）→ 进程树强杀 → 等 exit（5s 上限）→ failAll 未决请求。
- 服务器错误文本视为不可信输入：去控制字符并硬截断 500 字符（防止服务器回显参数造成泄密，绕过 persistArgs 脱敏管道）。
- 进程树杀：Windows 用 `taskkill /T /F`；POSIX 以 detached 进程组 spawn 后 `kill(-pid, SIGKILL)`。
- 重名工具首次注册胜出；stdout 上的非 JSON 噪声行被容忍跳过，stderr 持续排空。
- 服务器进程随宿主生命周期管理，暂无热重载（改配置需新一轮会话生效）。

## 测试

```bash
npx vitest run packages/plugin-mcp
```

`tests/mcp.test.ts` 使用 fixture 服务器（`tests/fixtures/echo-server.mjs`）覆盖握手、工具调用、容错与关停。
