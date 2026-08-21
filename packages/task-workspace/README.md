# task-workspace — 任务工作区持久化引擎

`@innocencecode/task-workspace` 是任务系统的落地层：内容寻址对象库（CAS）、工作区快照扫描、checkpoint 存储、
补丁引擎（diff / 反向应用 / 三方预检）、持久应用日志、跨进程双锁、私有任务目录布局、文件事件日志与
turn 提交协调器。承载工作流中"捕获变更"与"应用/丢弃"的磁盘语义。

## 作用

- **CAS 与快照**：`createContentStore`（put/has/get/path，sha256 键）、`scanWorkspace`（相对路径快照，
  跳过 symlink、二进制嗅探、按路径排序）。
- **补丁引擎**：`createPatchEngine` / `diffSnapshots` / `diffCheckpointToWorkspace` / `buildTextHunks`
  （hunk 指纹复用 task-core 的 `fingerprintHunk`）。
- **反向应用**：`applyReverse`（all-or-nothing：任一路径当前哈希不符即整体不动；事务前字节备份进 CAS）+
  `preflightThreeWay`。
- **持久应用日志**：`writeJournal/readJournal/recoverApplyJournals`——证明完成则补 committed，否则按 backupRef 回滚。
- **跨进程双锁**：`createTaskMutationLock` + `createWorkspaceWriteLock`——O_EXCL 锁文件，
  陈旧判定靠 PID 存活 + 进程启动身份（防 PID 复用），绝不靠超时；固定加锁顺序 task → workspace。
- **私有任务目录**：`openPrivateTaskStorage` 固定布局（objects/checkpoints/events.jsonl/task.json/artifacts/
  apply-journal/locks…），0700 / 仅当前用户 ACL（基于 secure-storage-node）。
- **事件日志与仓库**：`createFileEventLog`（追加前先修复撕裂尾部，非末行损坏 fail-closed）、
  `openTaskRepository`（head/事件/checkpoint/objects 的聚合门面，自身不加锁）。
- **turn 提交协调器**：`createTurnCommitCoordinator` 五步固定提交序（checkpoint 清单 → turnPrepared →
  transcript → turnCommitted → task head），崩溃后按 durability-first 写序恢复。

## 公开 API（节选）

| 导出 | 说明 |
|---|---|
| `openTaskRepository` / `openPrivateTaskStorage` | 任务仓库与加固目录布局 |
| `createContentStore` / `scanWorkspace` / `createCheckpointStore` | CAS、扫描、checkpoint |
| `createPatchEngine` / `diffCheckpointToWorkspace` / `buildTextHunks` | 补丁与 hunk |
| `applyReverse` / `preflightThreeWay` / `recoverJournals` | 反向应用与恢复 |
| `createWorkspaceWriteLock` / `createTaskMutationLock` / `acquireFileLock` | 跨进程锁族 |
| `createWorkspaceWatcher` | 文件观察（事件 source 恒为 "unknown"，归属由调用方决定） |
| `createFileEventLog` | 事件日志（repair-before-append） |
| `createTurnCommitCoordinator` | turn 五步提交与恢复 |

## 使用

```ts
import { openTaskRepository, createTaskMutationLock, createWorkspaceWriteLock, scanWorkspace } from "@innocencecode/task-workspace";

const repo = await openTaskRepository(storageRoot, taskId);        // 加固目录 + 事件日志
const taskLock = createTaskMutationLock(storageRoot);
const wsLock = createWorkspaceWriteLock(storageRoot);
const lease = await taskLock.acquire(taskId, owner);               // 先 task 后 workspace 的锁序
const snap = await scanWorkspace(workspaceRoot, { ignored: ["node_modules"] });
```

接线点：Electron 宿主 `src/main/taskRuntimeBridge.ts` / `src/main/taskPort.ts`（LiveTaskPort 的锁对、
watcher 支撑的 before/after 捕获）；CLI 宿主 `task-cli/src/runtime.ts`。

## 关键行为与约束

- 快照永远用相对路径（"/"分隔）；symlink/junction 不跟随不记录（防越界夹带）；二进制用 git 式 NUL 嗅探。
- 反向应用能处理"rename 已落但 journal 未记"的崩溃窗口；恢复语义与 task-git 的 journal 同构。
- 依赖 task-core（类型 + `recoverTask` + 指纹 + 事件工厂）与 secure-storage-node；
  刻意不依赖 plugin-task（用结构化 `TurnMutationContext` 规避横向依赖）。
- 协调器恢复规则：prepared 无 transcript 的 turn 丢弃；有 transcript 无 committed 的经验证后补齐，否则隔离并置 checkpoint-failed。

## 测试

```bash
npx vitest run packages/task-workspace
```

`tests/` 共 13 个文件：CAS / checkpoint / diff / 反向应用 / 双锁（含子进程用例）/ 私有存储 / 恢复 / watcher / 协调器等。
