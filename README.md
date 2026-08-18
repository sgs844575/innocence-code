# InnocenceCode — 自研 Agent Harness 的 AI 编程助手桌面客户端

基于 Electron 构建的 AI 编程助手：界面包含会话侧边栏、流式聊天、工具调用审批卡片与跟随系统主题。
后端是本项目自研的 **Agent Harness**（分层内核 + 万物皆插件），支持 OpenAI / Anthropic 双协议原生接入、
文件与终端工具、子代理、Skills 与 MCP。全部代码为本项目原创实现。

## 架构总览

```
React UI ←→ IPC 契约 ←→ harness-electron 适配层 ←→ harness-core（内核循环/权限/压缩）
                                                    ↘ 插件：fs / shell / subagent / skills / mcp
                                                    ↘ Provider：openai / anthropic / mock
```

- **内核（`packages/harness-core`）**：四个一等接口（`Provider` / `Tool` / `Skill` / `PolicyRule`）+
  同步可读的 AgentLoop、deny 优先的权限判定管线、token 估算与自动压缩、VS Code 风格插件注册表。
  零 Electron 依赖，将来可直接挂 CLI 宿主。
- **万物皆插件**：第一方能力（文件工具、终端、子代理、Skills、MCP）与第三方插件走完全相同的
  `activate(ctx)` 注册路径；扩展点是内核唯一的开放面。
- **权限体系**：模式（auto / ask / plan）+ 项目级白名单（`.innocence/config.json`）+ 会话授权；
  写操作强制落在工作区内，路径逃逸直接拒绝；未答复的审批超时默认拒绝。
- **上下文管理**：超过阈值自动压缩旧轮次（安全边界切分，工具配对不拆散），最近 6 条保原文。

## 技术栈

| 环节 | 方案 |
|---|---|
| 桌面框架 | Electron 42.3.0 + electron-forge 7.11.2 |
| 构建 | Vite 8.1.5，产物在 `.vite/build`；workspace 包经 vite alias 内联源码 |
| 前端 | React 19 + Tailwind v4 |
| Harness | TypeScript，npm workspaces 单仓（`packages/*`），vitest 103+ 测试 |
| 进程安全 | `sandbox: true` + `contextIsolation` + contextBridge，共享类型契约 |
| 持久化 | 会话 JSONL 逐轮追加（`userData/transcripts/`）；设置存 `userData/harness-settings.json` |

## 目录结构

```
InnocenceCode/
├── package.json               # 根：workspaces + typecheck/test 脚本
├── vite.main.config.ts        # 主进程构建 + @innocencecode/* 源码别名
├── docs/superpowers/specs/    # 设计规格（2026-08-18-agent-harness-design.md）
├── packages/                  # Harness（全部不依赖 Electron，除 harness-electron）
│   ├── harness-core/          # 内核：循环/权限/压缩/插件注册/子代理派生/SSE
│   ├── provider-openai/       # OpenAI 兼容协议（SSE 流式 + tool_calls 聚合）
│   ├── provider-anthropic/    # Anthropic messages（tool_use 流式聚合）
│   ├── provider-mock/         # 剧本化 Mock（离线开发与测试）
│   ├── tools-fs/              # Read / Write / Edit / Glob / Grep
│   ├── tools-shell/           # Bash（跨平台、超时、进程树终止、输出截断）
│   ├── plugin-subagent/       # Task 工具：隔离子代理（共享权限引擎，并发≤3）
│   ├── plugin-skills/         # SKILL.md 加载器（描述常驻索引、正文按需注入）
│   ├── plugin-mcp/            # MCP stdio 客户端（mcp__server__tool 映射）
│   └── harness-electron/      # 适配层：事件桥 + 审批桥 + JSONL 转写
└── src/
    ├── shared/ipc.ts          # IPC 通道 + 类型契约（主进程/预加载共用）
    ├── main/
    │   ├── index.ts           # 入口：单实例锁、生命周期、initHarness
    │   ├── harnessGlue.ts     # 设置持久化 + HarnessRuntime + 审批桥
    │   ├── ipc.ts             # ipcMain.handle 注册（含审批/工作区/设置通道）
    │   └── ...                # 窗口/协议/菜单/主题/日志
    ├── preload/index.ts       # contextBridge 最小 API 面
    └── webview/               # React UI（含 PermissionCard 审批卡片）
```

## 运行与测试

```bash
npm install
npm start          # 开发模式（vite dev server + electron）
npm test           # vitest 全仓测试（内核/双协议夹具回放/工具/运行时/自举替身）
npm run typecheck  # 应用侧类型检查
npm run typecheck:packages  # 各包类型检查
npm run package    # 打包验证（产物在 out/）
```

## 快速上手（让它真正干活）

1. `npm start` 启动应用；
2. 底部状态栏选择 **Provider**（OpenAI / Anthropic），在内联输入框填 API Key（仅存本机），
   OpenAI 兼容端点（Ollama、vLLM、网关）可改 Base URL；
3. 点 **选择工作区** 指定项目文件夹——文件与终端工具都限制在该目录内；
4. 权限模式选 **询问**（默认）：每个工具调用弹出审批卡片（允许一次 / 会话内允许 / 拒绝）；
   **自动** 模式全部放行（deny 规则仍生效）；**计划** 模式只读。
5. 会话中可用 `/技能名` 调用技能（见下）。

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

### 技能：`.innocence/skills/<name>/SKILL.md`

```markdown
---
name: review
description: 代码审查指南
---
审查时先看测试再看实现……（正文仅在调用时注入上下文）
```

## 自举验收（M6）

终极验收是**用 InnocenceCode 开发它自己**：启动应用 → 工作区选本仓库 → 让 agent 给
`packages/tools-fs` 加一个新工具并补测试（它会真实地 Read/Edit/Write 并跑 `npx vitest run`）。
仓库内 `packages/harness-electron/tests/bootstrap.test.ts` 是该流程的全自动替身：
完整运行时 + 真实文件工具 + shell + 审批门控跑通"读 → 改 → 写 → 验证"四步工作流。

## 已知限制

- 图标使用自绘 `>_` 几何标记；
- 会话 UI 层仍存内存（JSONL 转写已持久化，UI 恢复待做）；无更新器/遥测；
- 中途切换 Provider 会重建会话（历史保留），但 `.innocence/config.json` 变更需新一轮对话生效；
- MCP server 进程随宿主生命周期管理，暂无热重载。
