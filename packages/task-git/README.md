# task-git — 任务工作流的 Git 适配器

`@innocencecode/task-git` 承担任务审查工作流里的 Git 侧：worktree 生命周期、未提交基线的捕获/重放、
三方预检与审查通过内容的应用。只通过白名单 Git CLI 子命令操作（spawn 无 shell），绝不改 index、
不 stash、不创建 commit 或隐藏引用；任务状态持久化不在本包（归任务目录仓库）。

## 作用（工作流角色）

- **fork 隔离工作区**：`createWorktree`（detached，从 HEAD 或指定 baseCommit）+ `overlayBaseline` 把未提交改动重放进 worktree。
- **基线捕获**：`captureBaseline` 只读记录 staged/dirty/untracked（含重命名、mode、二进制），index 与工作区字节不变。
- **崩溃恢复**：`recoverWorktree` 按 lease 记录重放 worktree。
- **写回**：`preflightApply`（基线反向应用预检 / isolated 三方预检，all-or-nothing）+ `applyAccepted`（多文件写，可挂持久 journal）。
- **清理**：`destroyWorktree`（remove --force + prune）；`closeLease` 故意不删任何磁盘内容——worktree 必须活过重启。

## 公开 API（节选）

| 导出 | 说明 |
|---|---|
| `createGitAdapter(options)` | 聚合门面 → `GitAdapter`（detect / captureBaseline / createWorktree / overlayBaseline / preflightApply / applyAccepted / closeLease / recoverWorktree / destroyWorktree） |
| `GitAdapterOptions` | `gitPath? / maxOutputBytes?（默认 4 MiB）/ signal?` |
| `runGit` / `createGitRunner` / `isAllowedGitInvocation` | 白名单执行器；越权命令抛 `GitCommandRefusedError` |
| `detectGit` / `readGitStatus` / `parsePorcelainV2` | 仓库探测与 porcelain v2 解析 |
| `captureBaseline` / `overlayBaselineAt` / `GitBaseline` | 基线捕获与重放 |
| `preflightApply` / `applyAccepted` / `ConflictReport` / `ApplyResult` | 预检与应用（含 journal hook） |
| `WorktreeLease` / `listWorktrees` | worktree 租约与枚举 |

## 使用

```ts
import { createGitAdapter } from "@innocencecode/task-git";

const git = createGitAdapter();            // 可注入 gitPath / AbortSignal
const info = await git.detect(workspaceRoot);
if (!info.isRepo) throw new Error("isolated 任务要求 Git 仓库");

const baseline = await git.captureBaseline(workspaceRoot);   // 未提交改动 → 纯文件级记录
const lease = await git.createWorktree({ root, taskId, baseCommit });
await git.overlayBaseline(lease, baseline);                  // 基线重放进 worktree（当前字节赢）
```

接线点：Electron 宿主 `src/main/taskRuntimeBridge.ts` / `src/main/taskCommandService.ts`；
CLI 宿主 `task-cli/src/runtime.ts` 把它注入 task-core 的 `TaskCommandGit` 端口。

## 关键行为与约束

- **白名单子命令**：`rev-parse`（show-toplevel/HEAD）、`status --porcelain=v2 -z --branch`、`branch --show-current`、
  `ls-files -s`、`diff --cached`、`hash-object`（禁 -w）、`worktree add --detach|list --porcelain|remove --force|prune`；
  其余一律拒绝。输出每流 4 MiB 封顶。
- 哈希与 task-workspace 的 CAS 同词汇（本地 sha256）；apply 全程纯文件操作，写后用 `ls-files -s`/`diff --cached` 验证 index 逐字节不变。
- 所有内容先物化并哈希校验再落盘；注入 journal hook 时多文件写在持久事务下（与 task-workspace 的恢复引擎同构）。
- 不依赖 task-core/task-workspace（CAS 读取经注入的 `ContentReader` 端口；仅复用 secure-storage-node 的路径校验）。

## 测试

```bash
npx vitest run packages/task-git
```

`tests/`：应用集成、基线、状态解析、worktree（真实 git 仓库 fixture）。
