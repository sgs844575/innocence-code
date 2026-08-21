# plugin-subagent — Task 工具：隔离子代理插件

`@innocencecode/plugin-subagent` 注册 `Task` 工具：把一项独立任务委派给一个隔离的进程内子代理会话去完成。
子代理有自己的上下文与循环，中间过程不占用父会话上下文，只把最终报告返回——适合并行研究与探索。
子代理由脊柱 `harness-agent` 的 `createSpawnerPlugin` 派生（宿主侧经 AgentSession.spawner 暴露）：共享父会话的 Provider 与权限引擎（走同一套审批流），
并发上限 3，默认 `maxTurns` 20，Task 工具自身排除（防无限递归派生）。

## 作用

- 两种代理类型：
  - `explore` — 只读研究代理：只能使用只读工具（读文件 / 搜索），绝不修改文件，产出关键发现 / 涉及文件与行号 / 风险的简明报告。
  - `general` — 通用任务代理：在工具允许范围内完成任务，被拒权限时不重试同一操作。
- 每次调用自包含：`prompt` 必须给足目标、范围与期望产出（缺少直接校验失败）。

## 公开 API

| 导出 | 说明 |
|---|---|
| `SubagentPlugin` | 内核原生插件（name `subagent`），`apply` 时经脊柱 tools 服务注册 Task 工具 |
| `taskTool` | `Task` 工具本体（`Tool`），可单独注册 |
| `AgentType` | `"explore" \| "general"` |

Task 工具参数：`agentType`（必填）、`prompt`（必填）、`description`（一句话摘要，可选）。

## 使用

```ts
import { SubagentPlugin } from "@innocencecode/plugin-subagent";

plugins.push(SubagentPlugin); // 宿主接线见 src/main/harnessGlue.ts（插件开关 id: subagent，依赖 fs + shell）
```

模型侧的效果（无需宿主额外代码）：

```json
{ "agentType": "explore", "description": "摸清权限模块结构",
  "prompt": "研究 packages/harness-permissions/src/permission.ts 的判定顺序，返回管线各阶段与关键行号。" }
```

## 关键行为与约束

- `sideEffect: "delegated"`：副作用发生在子会话内、由子会话自行审计，父级不重复记账（任务变更捕获依赖此语义）。
- 权限资源只标识代理类型（`spawn:agent/explore|general`），prompt 内容绝不进入资源；
  持久化只保存代理类型与 prompt 哈希，prompt / description 原文不落盘。
- 宿主未注入 spawner 时（如部分测试宿主），调用返回"isError: 当前宿主不支持子代理"。
- 子代理的用户停止信号（AbortSignal）从 Task 调用传导，父会话中止会连带中止子代理。

## 测试

```bash
npx vitest run packages/plugin-subagent
```

`tests/subagent.test.ts` 用 mock provider + 假 spawner 覆盖注册、参数校验、explore 只读约束与结果回传。
