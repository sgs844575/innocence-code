# task-cli — 无 Electron 的任务命令入口

`@innocencecode/task-cli` 是任务工作流的 CLI 适配层：用真实实现（task-workspace + task-git +
plugin-task 的归属折叠）填充 task-core `TaskCommandService` 的全部端口，并提供注入式输出的审查渲染。
适配器永不直接碰任务存储，也不直写 stdout——所有输出经注入的 `TaskCliOutput`。

## 作用

- **runtime 组装器**：`createTaskCliRuntime(options)` 打开加固存储 → 按 taskId 缓存任务仓库 →
  逐端口接线（store/locks/workspace → task-workspace；git → task-git 的 `createGitAdapter`；
  diff → `diffCheckpointToWorkspace`；归属 → `foldAttributionDecisions`；fork/recover/delete 端口自实现）→
  `createTaskCommandService(deps)`。
- **适配器**：`createTaskCliAdapter(deps)` 是 19 个命令方法的瘦委托 + 审查渲染入口
  （`renderTask/renderReview/renderRouteList`）；`review` 缺省自动取当前 version 作 `expectedVersion`（单用户 CLI 流）。
- **审查渲染**：`renderTaskSummary / renderRoutes / renderChanges / renderHunks / renderConflicts / renderWarnings`
  产出结构化行（`TaskCliOutputLine`，带 kind 标记）写入注入的输出口。

## 公开 API（节选）

| 导出 | 说明 |
|---|---|
| `createTaskCliRuntime(options)` | 组装真实端口 → `TaskCliRuntime`（`service` / `locks` / `storageDir` / `canonicalRouteKey`） |
| `TaskCliRuntimeOptions` | `storageDir / git? / worktreeDir? / validator? / agentWriter? / lockTimeoutMs? / log?` |
| `createTaskCliAdapter(deps)` | 命令委托 + 渲染的适配器 |
| `collectStructuredOutput` | 测试/内嵌宿主用的输出收集器 |
| `TaskCliOutput` | 唯一输出口（写一行结构化输出） |
| `renderTaskSummary` 等 | 审查视图渲染函数族 |

## 使用

```ts
import { createTaskCliRuntime, createTaskCliAdapter, collectStructuredOutput } from "@innocencecode/task-cli";

const runtime = await createTaskCliRuntime({ storageDir, git: { workspaceRoot } });
const output = collectStructuredOutput();                       // 也可接任何 (line) => void
const cli = createTaskCliAdapter({ service: runtime.service, output });

const task = await cli.start({ mode: "isolated" });
await cli.renderTask(task.taskId);                              // 任务摘要 → 结构化行 → output
const changes = await cli.getChanges(task.taskId);
```

Electron 宿主用它做包级冒烟（`src/main/packageSmoke.ts`）与语义一致性校验
（`src/main/taskCommandParity.test.ts`：Electron ↔ CLI 等价接线钉住同一套行为）。

## 关键行为与约束

- 与 Electron 宿主的等价接线是**刻意重复**：CLI 工厂不含 watcher 与 live 端口（fork/recover/delete 编排无 watcher），
  Electron 侧保留 `src/main/taskRuntimeBridge.ts` 的完整接线；两者语义由 parity 测试钉住。
- fork 端口自实现编排：取 task lease → createWorktree(baseCommit) → overlayBaseline → 重放 fork 点 checkpoint →
  逐文件哈希验证后原子追加 routeAttached（失败回滚 head 并销毁 worktree）。
- recover 端口先 `recoverApplyJournals` 再逐路由 recoverWorktree；delete 端口销毁 worktree + 删任务目录。

## 测试

```bash
npx vitest run packages/task-cli
```

`tests/cli-integration.test.ts`（端到端命令流）+ `tests/workspace-lock-service.child.ts`（锁子进程用例）。
