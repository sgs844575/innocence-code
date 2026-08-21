# terminal-pty — 路由绑定 PTY 会话

`@innocencecode/terminal-pty` 是主进程侧的 PTY（伪终端）注册表与单会话封装：一个 `(taskId, routeId)` 对
一个活 shell，每个输出/退出事件都自带 `taskId / routeId / ptyId` 身份三元组，供终端 IPC 直通渲染进程。
只依赖 node-pty，无 Electron / DOM 面。

## 作用

- **PtyManager**：按 `${taskId}::${routeId}` 键管理会话——`create`（同键重建先 dispose 旧的）、
  `get`、`disposeForRoute`、`disposeAll`；每个事件经 `onEvent` 回调抛给宿主。
- **LivePtySession**：单会话封装——`write` 键入、`resize`、`output(settleMs)`（等静默后返回去 ANSI 的尾部缓冲）、
  `onExit`、`dispose`（树杀整棵进程树并等 exit 事件，幂等，不 reject）。

## 公开 API

| 导出 | 说明 |
|---|---|
| `createPtyManager(options)` | `{ onEvent, log? }` → `PtyManager` |
| `LivePtySession` | 会话类，实现 `PtySession`（字段 `ptyId / taskId / routeId / cwd`） |
| `PtyEvent` / `PtyOutputEvent` / `PtyExitEvent` | 事件类型（`output` 带 data，`exit` 带 exitCode） |
| `PTY_OUTPUT_BUFFER_MAX_CHARS` | 输出缓冲上限 1_000_000 字符（只留尾部，内存有界） |

## 使用

```ts
import { createPtyManager } from "@innocencecode/terminal-pty";

const pty = createPtyManager({
  onEvent: (event) => win.webContents.send("terminal:event", event), // 输出与退出直通渲染进程
});

const session = await pty.create({ taskId, routeId, cwd: workspaceRoot, cols: 120, rows: 30 });
session.write("npm test\r");
const tail = await session.output(); // 等待输出静默后取尾部缓冲
await pty.disposeForRoute(taskId, routeId);
```

Electron 宿主接线在 `src/main/terminalIpc.ts`（ID 白名单校验；cwd 只从任务桥解析，渲染进程只传 id 不传路径）。

## 关键行为与约束

- Shell 选择：Windows 用 `comspec || cmd.exe`，其他平台 `$SHELL || /bin/sh`；`TERM=xterm-256color`。
- 尺寸消毒：cols/rows 必须是 2..500 的整数，否则回落 `80x24`；`create` 要求 taskId/routeId 非空且 cwd 必填。
- `dispose` 树杀：Windows `taskkill /pid <pid> /T /F`（普通 kill 杀不干净包装 shell 的子进程），POSIX SIGKILL；
  等 exit 最多 5s，超时兜底 `pty.kill()`；`output()` 总等待上限 10s。
- `onEvent` 逐字节全量推送不受缓冲上限影响；上限只约束 `output()` 可回看的尾部缓冲。

## 测试

```bash
npx vitest run packages/terminal-pty
```

`tests/pty.test.ts` 覆盖会话生命周期、输出缓冲与树杀（宿主侧另有 `src/main/terminalIpc.test.ts`）。
