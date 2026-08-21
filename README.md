# InnocenceCode

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Made with Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)

**InnocenceCode** 是一个基于自研 Agent Harness 的 AI 编程助手桌面客户端：会话侧边栏、流式聊天、
工具调用审批卡片、任务工作区（fork / 变更捕获 / 审查 / 应用）与跟随系统主题的界面。
后端为本项目原创实现的分层内核 + "万物皆插件"架构，支持双协议 Provider 原生接入、文件与终端工具、
子代理、Skills 与 MCP。全部代码为本项目原创实现。

- 仓库：<https://github.com/sgs844575/innocence-code>
- 问题反馈：<https://github.com/sgs844575/innocence-code/issues>
- 作者：[逆流无邪](https://github.com/sgs844575)

## 特性

- **自研 Agent Harness**：四个一等扩展接口（`Provider` / `Tool` / `Skill` / `PolicyRule`）、同步可读的
  Agent 循环、deny 优先的权限判定管线、token 估算与自动压缩——内核零 Electron 依赖，可直接挂 CLI 宿主。
- **万物皆插件**：第一方能力（文件工具、终端、子代理、Skills、MCP、任务捕获）与第三方插件走完全相同的
  `activate(ctx)` 注册路径；扩展点是内核唯一的开放面。
- **权限体系**：模式（auto / ask / plan）+ 项目级白名单（`.innocence/config.json`）+ 会话授权；
  写操作强制落在工作区内，路径逃逸直接拒绝；原始工具参数绝不进入历史 / 事件 / 审计（持久化前统一脱敏）。
- **任务工作流**：为每个任务 fork 隔离的 Git worktree，捕获归属工作区变更，逐 hunk 审查后应用或丢弃——
  事件溯源状态机 + 跨进程双锁 + 崩溃恢复，全程不触碰你的 Git index。
- **上下文管理**：超过阈值自动压缩旧轮次（安全边界切分，工具配对不拆散），最近 6 条保原文。
- **双协议原生 Provider**：OpenAI 兼容端点（含本地推理与网关）与 Anthropic messages 协议，
  均为流式原生实现；离线开发可用剧本化 Mock Provider。
- **自研插件内核**：`vendor/kernel` 一族（context / fiber / effects / events）为更底层的通用插件运行时，
  独立演进中。

## 架构总览

```
React UI ←→ IPC 契约 ←→ harness-electron 适配层（会话/路由运行时 + AgentSession）
                                                    ↘ 内核与脊柱（vendor/kernel + 脊柱八包）：循环/权限/工具/技能/子代理
                                                    ↘ 插件：fs / shell / subagent / skills / mcp / task / todo（磁盘分发装载）
                                                    ↘ Provider：openai / anthropic / mock
                                任务系统：task-core（状态机）+ task-git（worktree）+ task-workspace（持久化）
```

依赖方向单向：宿主适配层 → 插件 / Provider / 工具 / 运行时 → 内核与脊柱包（`vendor/kernel` + `harness-*` 脊柱）；领域包之间只通过核心协议
或注入端口通信，全部 `packages/*` 包不依赖 Electron / React / DOM（唯一例外是宿主适配层 `harness-electron`，
它也不直接 import Electron API，而是经注入的端口工作）。内核、注册脊柱与能力插件随构建分发到
`resources/{node_modules,plugins}`，宿主运行时动态装载（主 bundle 零 workspace 静态依赖）。

## 快速开始

### 环境要求

- Node.js ≥ 22
- npm（随 Node 附带）
- Git（任务工作流的 isolated 模式需要）

### 安装与运行

```bash
git clone https://github.com/sgs844575/innocence-code.git
cd innocence-code
npm install
npm start          # 开发模式（vite dev server + electron）
```

### 常用命令

| 命令 | 说明 |
|---|---|
| `npm start` | 开发模式运行 |
| `npm test` | 全仓 vitest 测试（内核 / 双协议夹具回放 / 工具 / 任务系统 / 运行时） |
| `npm run typecheck` | 应用侧 TypeScript 类型检查 |
| `npm run typecheck:packages` | 各 workspace 包类型检查 |
| `npm run package` | 打包（Electron Forge，产物在 `out/`） |
| `npm run make` | 生成分发安装包 |
| `npm run package:smoke` | 打包产物冒烟验收 |

## 使用指南

1. `npm start` 启动应用；
2. 底部状态栏选择 **Provider**，在内联输入框填 API Key（仅存本机）；OpenAI 兼容端点
   （本地推理、私有网关）可修改 Base URL；
3. 点 **选择工作区** 指定项目文件夹——文件与终端工具都限制在该目录内；
4. 权限模式选 **询问**（默认）：每个工具调用弹出审批卡片（允许一次 / 会话内允许 / 拒绝）；
   **自动** 模式全部放行（deny 规则仍生效）；**计划** 模式只读；
5. 会话中可用 `/技能名` 调用技能。

### 项目配置：`.innocence/config.json`（放在工作区根）

```json
{
  "permissions": {
    "allow": ["Read", "Grep", "Glob", "Bash(npm test)", "Edit(src/**)"],
    "deny": ["Bash(rm *)"]
  },
  "mcpServers": {
    "example": { "command": "npx", "args": ["-y", "some-mcp-server"] }
  }
}
```

- `Bash(npm test)` 只放行该命令前缀序列（`*` 匹配任意单个词）；`Edit(src/**)` 按工作区相对路径 glob；
  deny 永远优先于 allow。
- `mcpServers` 里的每个 server 启动后工具以 `mcp__example__工具名` 注册，默认走审批。
- 插件开关：`.innocence/plugins.yml`（项目层）覆盖用户层设置，支持 subagent / skills / mcp / todo。

### 技能：`.innocence/skills/<name>/SKILL.md`

```markdown
---
name: review
description: 代码审查指南
---
审查时先看测试再看实现……（正文仅在调用时注入上下文）
```

### 任务工作流

从会话派生任务后，agent 在隔离的 Git worktree 中工作：产生的变更被逐文件捕获并归属
（外部改动受保护，不会被误应用），你逐 hunk 审查，最终选择应用回原工作区或丢弃。
任务状态为事件溯源（单一事件日志），崩溃后可完整恢复；整个过程绝不使用或修改你的 Git index。

## 目录结构

```
innocence-code/
├── package.json               # 根：workspaces（packages/* + vendor/*）+ 脚本
├── LICENSE                    # AGPL-3.0
├── forge.config.ts            # Electron Forge 打包配置
├── vite.*.config.ts           # 主进程/预加载/渲染构建（workspace 经 node_modules 解析，无别名）
├── docs/                      # 设计规格
├── packages/                  # Harness 与领域包（除 harness-electron 外均不依赖 Electron）
│   ├── harness-electron/      # 适配层：路由会话运行时 + AgentSession + 设置 + JSONL 转写
│   ├── harness-tools/         # 脊柱：工具注册/执行/脱敏/执行作用域
│   ├── harness-permissions/   # 脊柱：权限引擎/策略/项目规则
│   ├── harness-providers/     # 脊柱：Provider 注册/SSE 解析
│   ├── harness-session/       # 脊柱：消息模型/处理器/压缩
│   ├── harness-skills/        # 脊柱：技能注册与索引
│   ├── harness-system-prompt/ # 脊柱：系统提示词分段
│   ├── harness-agent/         # 脊柱：子代理派生服务
│   ├── harness-agent-loop/    # 脊柱：Agent 循环（runLoop）
│   ├── provider-openai/       # OpenAI 兼容协议（SSE 流式 + tool_calls 聚合）
│   ├── provider-anthropic/    # Anthropic messages（tool_use 流式聚合）
│   ├── provider-mock/         # 剧本化 Mock（离线开发与测试）
│   ├── tools-fs/              # Read / Write / Edit / Glob / Grep
│   ├── tools-shell/           # Bash（跨平台、超时、进程树终止、输出截断）
│   ├── tools-todo/            # TodoWrite（transcript 会话清单）
│   ├── plugin-subagent/       # Task 工具：隔离子代理（共享权限引擎，并发≤3）
│   ├── plugin-skills/         # SKILL.md 加载器（描述常驻索引、正文按需注入）
│   ├── plugin-mcp/            # MCP stdio 客户端（mcp__server__tool 映射）
│   ├── plugin-task/           # 任务变更捕获中间件（声明路径快照 + 归属状态机）
│   ├── plugin-example/        # 插件示例（预构建管线样例）
│   ├── task-core/             # 任务状态机：事件/ reducer / 路由 / 审查 / 命令服务
│   ├── task-git/              # Git worktree/基线/应用适配器（白名单子命令）
│   ├── task-workspace/        # 快照/CAS/补丁引擎/双锁/事件日志/提交协调
│   ├── task-cli/              # 无 Electron 的任务 CLI 适配层
│   ├── terminal-pty/          # 路由绑定 PTY 会话（taskId+routeId 键控）
│   └── secure-storage-node/   # 私有磁盘存储（POSIX 0700 / Windows ACL 加固）
├── vendor/                    # 自研插件内核族（独立包，workspace 成员）
│   ├── kernel/                # context / fiber / effects / events 内核
│   ├── kernel-include/        # YAML 条目内建
│   ├── kernel-loader/         # 配置树加载器
│   └── kernel-logger/         # 内核日志服务插件
├── src/
│   ├── shared/ipc.ts          # IPC 通道 + 类型契约（主进程/预加载共用）
│   ├── main/                  # Electron 主进程：生命周期/组合根/IPC/任务桥/终端桥
│   ├── preload/index.ts       # contextBridge 最小 API 面
│   └── webview/               # React UI（含审批卡片 / 任务审查 / 终端面板）
└── tests/                     # 顶层验收测试（打包冒烟等）
```

各包的作用、公开 API、接线方式与约束见其目录下的 `README.md`。

## 开发指南

- **新增能力优先做成插件**：新的 Provider / 工具 / 技能 / 策略 / 消息处理器应落在可独立测试的
  `packages/*` 模块，通过 harness 扩展点注册；领域包保持宿主无关（不 import Electron / React / DOM）。
- **测试要求**：领域行为必须有非 UI 的 Node/Vitest 覆盖（fake 端口 / mock provider / CLI 式集成测试），
  UI 测试只作补充。提交前运行 `npm test`、`npm run typecheck`、`npm run typecheck:packages`；
  改动主进程 / 预加载 / 打包相关时另跑 `npm run package`。
- **文件操作安全**：Windows 上不要用 PowerShell `Get-Content`/`Set-Content` 或 CMD 重定向改写仓库文本
  （编码依赖系统区域设置），统一用显式 UTF-8 的编辑工具或 Node API。
- 完整贡献规范与架构约束见 [AGENTS.md](./AGENTS.md)。

### 自举验收（M6）

终极验收是**用 InnocenceCode 开发它自己**：启动应用 → 工作区选本仓库 → 让 agent 给 `packages/tools-fs`
加一个新工具并补测试（它会真实地 Read/Edit/Write 并跑 `npx vitest run`）。
仓库内 `packages/harness-electron/tests/bootstrap.test.ts` 是该流程的全自动替身：
完整运行时 + 真实文件工具 + shell + 审批门控跑通"读 → 改 → 写 → 验证"四步工作流。

## 已知限制

- 图标使用自绘 `>_` 几何标记；
- 无更新器 / 遥测；
- 中途切换 Provider 会重建会话（历史保留），`.innocence/config.json` 变更需新一轮对话生效；
- MCP server 进程随宿主生命周期管理，暂无热重载。

## 许可证

本项目以 [GNU Affero General Public License v3.0](./LICENSE)（AGPL-3.0）发布。
你可以自由使用、研究、修改和分发本软件；但任何基于本软件的修改版和网络服务分发，
都必须以 AGPL-3.0 向用户开放完整对应源码。

Copyright (C) 2026 逆流无邪
