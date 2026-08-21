# task-core — 任务状态机领域内核

`@innocencecode/task-core` 是"任务工作流"的大脑：纯事件溯源的任务状态机——事件词汇、reducer、崩溃恢复、
路由 DAG、hunk 审查指纹与宿主无关的 `TaskCommandService` 命令编排。不含任何存储/进程实现
（存储、Git、锁、diff 全部经端口注入），不依赖其他 workspace 包，被任务栈其余三包依赖。

## 作用

任务工作流：**fork 隔离工作区 → 捕获变更 → 归属 → 审查 → 应用/丢弃**。本包定义：

- **模型**（`model.ts`）：`TaskHead / Route / Checkpoint / TaskTurn / Hunk / TaskStatus / ReviewStatus / TurnPhase` 及不可变助手。
- **事件**（`events.ts`）：14 种 `TaskEvent`（taskCreated / turnCheckpointed / routeAttached / turnPrepared /
  turnCommitted / changeRecorded / attributionPending / attributionConflict / attributionResolved /
  conflictResolved / hunkReviewed / activeRouteChanged / validationOverride / taskStatus）及各工厂函数。
- **reducer**（`reducer.ts`）：`reduceTask(events)` 纯折叠，逐事件严格校验（未知/不完整事件抛结构化 `TaskRecoveryError`，绝不静默跳过）。
- **恢复**（`recovery.ts`）：`recoverTask(raw)` 对 events.jsonl 原文重放，末行撕裂容忍并标记 `truncatedTail`。
- **路由与分叉**（`route.ts` / `fork.ts`）：路由 DAG（环检测）、`forkFromUserMessage` / `retryAssistantTurn` 纯命令解析。
- **审查**（`review.ts`）：`fingerprintHunk`（SHA-256 规范化指纹）、`migrateReviewStatuses` 按指纹迁移审查状态。
- **命令服务**（`command-service.ts` 族）：`createTaskCommandService(deps)` 暴露 19 个方法
  （start / getChanges / listRoutes / switchRoute / forkFromUser / retryAssistant / listHunks / review /
  restore / attributeUnknown / resolveConflict / validate / complete / applyAccepted / recover / delete …），
  端口全部由实现方注入（store/locks/workspace/git/diff/attribution/fork/recover/delete）。

## 公开 API（节选）

| 导出 | 说明 |
|---|---|
| `createTaskCommandService(deps)` | 命令服务入口；`TaskCommandDeps` 声明 9 个必需端口 |
| `reduceTask(events)` / `recoverTask(raw)` | 状态折叠与崩溃恢复 |
| `TaskEvent` 联合 + 事件工厂 | 单一事件日志的词汇表（与 plugin-task 共用） |
| `createRoute` / `attachRoute` / `RouteMap` | 路由 DAG |
| `fingerprintHunk` / `migrateReviewStatuses` | hunk 指纹与审查状态迁移 |
| `forkFromUserMessage` / `retryAssistantTurn` | 分叉命令解析 → `ForkRequest` |
| `TaskCommandError` / `TASK_STATUSES` / `TASK_ID_PATTERN` / `DEFAULT_LOCK_TIMEOUT_MS` | 常量与错误 |

## 使用

```ts
import { createTaskCommandService, reduceTask } from "@innocencecode/task-core";

const service = createTaskCommandService({
  store,      // TaskCommandStore：事件日志/头部/对象/checkpoint —— 实现方：task-workspace
  locks,      // TaskCommandLocks：task+workspace 双锁 —— 实现方：task-workspace
  workspace,  // 扫描/哈希/读取 —— 实现方：task-workspace
  git,        // worktree/基线/应用 —— 实现方：task-git
  diff, attribution, fork, recover, delete, // …其余端口
});

const task = await service.start({ workspaceRoot, mode: "isolated" });
const state = reduceTask(events); // 任意时刻从事件日志推导状态
```

两个现成组装器：Electron 宿主（`src/main/taskCommandService.ts`）与无 Electron 的 `task-cli`（`createTaskCliRuntime`）。

## 关键行为与约束

- 单一事件日志（含 plugin-task 的归属事件）：一个日志、一次恢复；归属"解释"归 plugin-task，本包只校验形状。
- 每次变更按固定顺序先取 task lease 再取 workspace lease；租约内重读日志作为 `expectedVersion`（最后 eventId）CAS 基础。
- 完成门（运行中工具/未解决冲突/prepared turns/未审查变更/校验）整体在租约内计算；校验失败可显式覆写（落 validationOverride）。
- apply/restore 走持久 apply journal；start 失败自毁 worktree 不留孤儿；isolated 模式在非 Git 仓库 fail-closed。

## 测试

```bash
npx vitest run packages/task-core
```

`tests/`：命令服务契约、事件、分叉、模型、审查、路由共 6 个测试文件。
