# tools-todo — 会话任务清单工具插件（TodoWrite）

`@innocencecode/tools-todo` 注册 `TodoWrite` 工具：维护当前会话的任务清单（计划与执行跟踪）。
清单是纯会话状态——只通过持久化的工具调用参数存在于 transcript 中，每次调用整体替换上一份清单，
从不写工作区、无外部副作用。

## 作用

- 模型用 `todos` 数组（`content / status / priority`）整体替换清单，非增量追加。
- 回执给模型一份紧凑摘要（如"3 项：1 进行中 / 2 待办"）+ 带序号的逐条列表，超长条目回显截断。
- 校验报错只点名失败字段（如 `todos[2].status 必须是 …`），绝不回显字段内容——工具错误会未经脱敏进入历史/审计。

## 公开 API

| 导出 | 说明 |
|---|---|
| `todoPlugin` | `HarnessPlugin`（name `todoPlugin`），激活时注册 TodoWrite 工具 |
| `todoWriteTool` | `TodoWrite` 工具本体 |
| `TodoItem` / `TodoStatus` / `TodoPriority` | 清单条目类型（`pending/in_progress/completed` × `high/medium/low`） |
| `todoSummary(todos)` | 数量摘要文案（导出供测试/UI 复用） |

## 使用

```ts
import { todoPlugin } from "@innocencecode/tools-todo";

plugins.push(todoPlugin); // 宿主接线见 src/main/harnessGlue.ts（插件开关 id: todo）
```

## 关键行为与约束

- `readOnly: true`、`sideEffect: "none"`：写的是"会话清单"这一逻辑动作，plan 模式也放行；
  权限资源恒为 `write:todo/session`。
- 上限：清单 100 条（超出校验拒绝）；单条内容回显 500 字符截断。
- `persistArgs` 走与校验相同的路径重建对象数组——剥离多余字段，且与原始参数不共享嵌套引用。

## 测试

```bash
npx vitest run packages/tools-todo
```

`tests/todo.test.ts` 覆盖校验、整体替换语义、摘要与回显截断。
