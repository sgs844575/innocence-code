# plugin-task — 任务变更捕获插件

`@innocencecode/plugin-task` 是"任务工作流"（fork 隔离工作区 → 捕获变更 → 审查 → 应用/丢弃）中的捕获层：
向 harness-core 的 AgentLoop 注入 `ToolExecutionMiddleware`，在任务作用域内每个"写入类"工具调用周围做
before/after 快照，把工作区变更归属到任务（attribution 状态机）；存在未归属变更时阻塞新的写入工具。

## 作用

- **捕获中间件**：权限已通过 → 取任务/工作区锁（固定锁序）→ 读版本（CAS）→ 归属闸门 →
  `captureBefore`（仅声明写路径）→ 执行工具 → finally `captureAfter`（watcher + 扫描）→ 追加事件/暂停归属 → 释放锁。
- **声明路径快照**：声明写路径由 `tool.permissionResource(persistedArgs)` 推导（`kind === "path"` 且非 read），
  只使用持久化参数——与权限链看到的一致，原始参数不进本层。
- **归属状态机**（纯函数）：`candidate → attribution-pending →（task-owned → pending-review / external → excluded）`；
  候选与声明写重叠 → `conflict`；外部归属路径受保护哈希约束，恢复/应用永不触碰。
- **闸门语义**：未解决状态集合 `{candidate, attribution-pending, conflict}` 阻塞新的写入工具，
  返回类型化拒绝结果（`ATTRIBUTION_BLOCKED`），不捕获、不落快照。
- **委托去重**：委托调用（`sideEffect: "delegated"`）与子作用域变更只在子侧计一次，父任务声明写标 `declared`，不重复记账。

## 公开 API（节选）

| 导出 | 说明 |
|---|---|
| `taskPlugin(options)` | 构造 `HarnessPlugin`（name `task-change-capture`）注入中间件 |
| `createTaskCaptureMiddleware(options)` | 直接构建 `ToolExecutionMiddleware`（`port / lookupTool / workspaceRoot / log`） |
| `resolveTaskAttribution(port, scope, resolution)` | 在租约下应用一次用户归属答复并追加 `attributionResolved` |
| `ATTRIBUTION_BLOCKED` / `attributionBlockedResult` / `isAttributionBlocked` | 归属阻塞的类型化结果与判定 |
| `foldAttributionDecisions(events)` | 从事件日志折叠当前归属决策（宿主命令服务用它派生状态） |
| `toAttributionPending` / `resolveAsTaskOwned` / `resolveAsExternal` / `classifyUnknownChanges` 等 | 归属纯函数族 |
| `TaskRuntimePort` | 持久化/锁/快照端口接口（真实实现在宿主 `src/main/taskPort.ts`） |
| `TaskScope` / `asTaskScope` | harness-core `ExecutionScope` + 必填 `taskId/routeId`；非任务作用域直接放行 |

## 使用

```ts
import { taskPlugin } from "@innocencecode/plugin-task";

// 宿主接线（src/main/taskRuntimeBridge.ts）：按路由注入——非任务会话返回空数组
const plugins = taskPluginsForRoute(bridge, { taskId, routeId });
// 其中：taskPlugin({ port: liveTaskPort, lookupTool: (n) => toolIndex.get(n), workspaceRoot })
```

归属答复（用户在 UI 上确认"这是我改的/外部改动"）经 `resolveTaskAttribution` 落为
`attributionResolved` 事件，与 task-core 共用同一条事件日志（`TaskEvent` 即 task-core 的联合类型）。

## 关键行为与约束

- 捕获条件：工具 `sideEffect ∈ {paths, process, network, unknown}`；`readOnly: false` 且未写 sideEffect 按 `unknown` 处理（fail-closed）。
- 拦截链顺序由 harness-core 决定：权限通过后才进中间件；`captureAfter` 在 finally 中执行（工具抛错也捕获），
  但捕获失败会掩盖工具原始错误（fail-closed）。
- 只有 `attribution-pending` 状态可被 resolve；外部删除保护"不存在态"（protectedHash 为空串）。
- 未知路径的归属答复 fail-closed 拒绝，不允许把未跟踪路径悄悄划走。

## 测试

```bash
npx vitest run packages/plugin-task
```

`tests/` 下：归属状态机（`attribution.test.ts`）、委托去重（`delegation.test.ts`）、中间件流程（`middleware.test.ts`）。
