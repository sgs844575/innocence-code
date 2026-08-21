# tools-shell — Shell 命令执行工具插件（Bash）

`@innocencecode/tools-shell` 注册 `Bash` 工具：在工作区根执行 shell 命令（Windows 用 cmd，其他平台用 sh），
适合跑测试、构建、装依赖。跨平台进程树终止、超时上限与输出截断内置。

## 作用

- `runCommand(options)`：核心执行原语——`spawn(shell: true)` + 超时（默认 120s）+ AbortSignal + 输出截断捕获，
  可脱离插件单独复用。
- `bashTool` / `shellPlugin`：面向模型的 `Bash` 工具与其插件包装。

## 公开 API

| 导出 | 说明 |
|---|---|
| `shellPlugin` | `HarnessPlugin`（name `tools-shell`），激活时注册 Bash 工具 |
| `bashTool` | `Bash` 工具本体（`Tool`） |
| `runCommand(options)` | `{ command, cwd, timeoutMs?, signal?, maxOutputChars? }` → `{ stdout, stderr, exitCode, timedOut }` |

Bash 工具参数：`command`（必填）、`timeoutMs`（可选，默认 120000）。

## 使用

```ts
import { shellPlugin } from "@innocencecode/tools-shell";

plugins.push(shellPlugin); // 宿主接线见 src/main/harnessGlue.ts（插件开关 id: shell，core 恒开）
```

## 关键行为与约束

- **进程树终止**：`shell: true` 会产生包装 shell，普通 `kill()` 杀不掉其子进程——Windows 用
  `taskkill /pid <pid> /T /F`，POSIX 用 SIGKILL；超时与用户中止都走树杀。
- **输出截断**：stdout+stderr 合计上限 30000 字符，超出部分以 `…[已截断]` 标记。
- **权限资源**：scope 是脱敏命令摘要（程序词 + 合法形状的 subcommand token）——会话授权因此能区分
  `npm test` 与 `npm publish`；完整命令绝不进入资源。
- **持久化脱敏**：只保存命令摘要与命令哈希；完整命令与参数值绝不持久化，项目 allow/deny 规则按摘要前缀匹配
  （如 `Bash(npm test)` 放行该前缀序列，`*` 匹配任意单个词）。
- 非零退出码或超时都会把结果标记为 `isError`，stderr 一并回喂模型自行修正。

## 测试

```bash
npx vitest run packages/tools-shell
```

`tests/shell.test.ts` 覆盖执行、超时、中止、截断与脱敏。
