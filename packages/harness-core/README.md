# harness-core — Agent 执行内核

`@innocencecode/harness-core` 是整个 harness 的内核：定义四个一等扩展接口（`Provider` / `Tool` / `Skill` / `PolicyRule`）、
同步可读的 Agent 循环、deny 优先的权限判定管线、上下文自动压缩、VS Code 风格插件注册表与声明式插件开关。
零 Electron / DOM 依赖，Electron、CLI 与测试宿主都以相同方式接入。

## 作用

- **Agent 循环**：`runLoop` 流式跑一个模型回合 → 每个工具调用先过权限引擎 → 结果回喂模型 → 重复直到模型给出无工具调用的回答；中途 `stop` 对剩余调用 fail-closed 并记 `aborted`，工具失败回喂模型而非终止循环。
- **会话**：`AgentSession` 把注册表、Provider、权限引擎、压缩器与事件流绑成一个会话，宿主只订阅事件并注入权限决策回调。
- **插件注册表**：`PluginRegistry` 是插件唯一开放面——`activate(ctx)` 里注册工具/Provider/技能/策略/中间件；重复注册抛错，注册面 fail-closed。
- **权限体系**：`PermissionEngine` 短路管线（资源硬校验 → full 放行 → deny 规则 → plan 只读 → allow 规则 → auto → 会话授权 → ask），deny 永远优先，每次判定都审计。
- **上下文管理**：`ContextManager` 超过 token 阈值自动压缩旧轮次，切分点必须落在纯文本 user 消息（工具配对不拆散）。
- **配置与开关**：加载 `.innocence/config.json`（权限规则 + MCP 服务器）与 `.innocence/plugins.yml`（项目层覆盖用户层的插件开关，依赖禁用传递跳过）。
- **子代理派生**：`bindSubagentSpawner` 让子代理共享父会话的 Provider 与权限引擎（同审批流），并发上限 3。

## 公开 API（节选）

| 导出 | 说明 |
|---|---|
| `runLoop(history, input, opts)` | 核心 Agent 循环；`LoopOptions` / `LoopResult` |
| `AgentSession.create(options)` | 一站式会话；`run/stop/dispose/on/setPermissionMode` 等 |
| `PluginRegistry` / `HarnessPlugin` / `PluginContext` | 插件注册面与激活上下文 |
| `PermissionEngine` / `resourceGrantKey` | 权限判定与授权键 |
| `parseRuleSpec` / `rulesFromConfig` / `loadInnocenceConfig` | 权限规则解析与项目配置加载 |
| `resolvePluginSet` / `loadPluginToggles` | 两级（用户/项目）插件开关解析 |
| `ContextManager` / `estimateTokens` / `findSplitIndex` | 上下文压缩 |
| `executeToolInvocation` / `ToolExecutionMiddleware` | 工具执行器与中间件链 |
| `bindSubagentSpawner` | 子代理派生绑定 |
| `globToRegExp` / `matchGlob` / `parseSSEData` | glob / SSE 基础设施 |
| `redactCommand` / `redactUrl` / `sha256Hex` | 脱敏与哈希工具 |

消息与协议类型（`Message` / `Delta` / `Tool` / `Skill` / `PolicyRule` / `ExecutionScope` 等）均从这里导出，
保持宿主与 Provider 中立——不含 Electron、IPC、DOM 或任何 wire 格式。

## 使用

```ts
import { AgentSession } from "@innocencecode/harness-core";
import { fsPlugin } from "@innocencecode/tools-fs";
import { shellPlugin } from "@innocencecode/tools-shell";

const session = AgentSession.create({
  plugins: [fsPlugin, shellPlugin, subagentPlugin], // 全部走同一条 activate(ctx) 路径
  provider,                     // Provider 实例，或插件注册的 providerId
  workspaceRoot: "/path/to/repo",
  systemPrompt: "…",
  permission: {
    mode: "ask",
    decider: async (req) => "allow",   // 宿主注入：弹审批卡片/读配置
    projectConfig,                     // rulesFromConfig(loadInnocenceConfig(...).permissions)
  },
});

session.on((event) => console.log(event));
const summary = await session.run("帮我看看 src/index.ts");
await session.dispose();
```

Electron 宿主的实际组合根在 `src/main/harnessGlue.ts`：`loadInnocenceConfig` + `loadPluginToggles` +
`resolvePluginSet` 决定激活插件集，再逐个注入 `AgentSession`。

## 关键行为与约束

- 每个工具调用固定执行 `validateArgs(raw) → permissionResource(raw) → persistArgs(raw)`：原始参数只留在闭包内，
  历史 / 事件 / 权限 / 审计只能看到持久化（脱敏后）参数；Tool 缺 `permissionResource` / `persistArgs` 直接抛 `ToolPersistenceError`。
- 权限管线全模式先做资源硬校验（fail-closed），`full` 模式在最顶层短路；会话授权按 `tool+action+kind+scope` 精确匹配，不跨作用域泄漏。
- 压缩默认：`maxContextTokens` 48000、`keepRecent` 6；token 估算 ≈ JSON 长度 / 4；无安全切分点则压缩为 no-op。
- `DEFAULT_MAX_TURNS = 40`，`DEFAULT_TOOL_TIMEOUT_MS = 120_000`；子代理默认 `maxTurns` 20 且 Task 工具自身排除。
- 本包不依赖任何其他 workspace 包；其他包只应通过核心协议或注入端口通信。

## 测试

```bash
npx vitest run packages/harness-core
```

覆盖：循环 / 会话 / 权限 / 注册表 / 压缩 / 插件开关 / 配置解析 / 工具执行与脱敏 / glob / SSE 等共 14 个测试文件。
