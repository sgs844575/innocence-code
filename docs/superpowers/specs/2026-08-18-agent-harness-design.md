# InnocenceCode Agent Harness 设计规格

日期：2026-08-18
状态：已批准（方案 B：分层内核 + 显式扩展点）

## 1. 背景与目标

InnocenceCode 当前是一个 Electron AI 聊天客户端壳子：UI 与 IPC 契约完整，但后端唯一的"模型"是 `src/main/mockAgent.ts`（假流式回复）。本设计补上缺失的核心——**Agent Harness**：把 LLM 变成能干活的 agent 的运行时层（循环、工具调用、上下文管理、权限控制）。

**目标形态**：可复用的 Harness 核心库，不绑定 Electron；第一步接入 InnocenceCode 替换 mockAgent；将来可挂 CLI 或其他宿主。

**验收标准（自举）**：用 InnocenceCode + 本 Harness 开发它自己的一个新功能，全程权限审批可观测。这是"它活了"的终极证明。

### 需求决议

| 维度 | 决议 |
|---|---|
| 形态 | 可复用核心库（npm workspaces 单仓），宿主适配层隔离 Electron |
| 能力 | 文件工具、终端命令、子 agent、MCP、Skills/插件系统（万物皆插件） |
| 模型接入 | OpenAI 与 Anthropic 双协议原生实现（不用上游 SDK） |
| 权限 | 完整体系一步到位：模式（auto/ask/plan）+ 项目级白名单 + 会话授权 |
| 插件哲学 | 工具、Provider、Skill、权限规则都是插件；扩展点是内核唯一的开放面 |

## 2. 架构

### 2.1 包结构

```
packages/
├── harness-core          # 内核：接口 + AgentLoop + 上下文压缩 + 权限引擎 + 插件注册表
├── provider-mock         # 剧本化 Mock Provider（离线开发/测试）
├── provider-openai       # OpenAI 兼容协议（fetch + SSE 流式 + tool call 解析）
├── provider-anthropic    # Anthropic 原生协议（messages API + tool_use 流式）
├── tools-fs              # Read / Write / Edit / Glob / Grep
├── tools-shell           # 命令执行（超时、输出截断）
├── plugin-subagent       # "Task" 工具：进程内嵌套 AgentSession
├── plugin-skills         # SKILL.md 加载器
├── plugin-mcp            # MCP stdio 客户端
└── harness-electron      # 适配层：事件桥到 IPC + 审批 UI 通道 + 持久化
```

**约束**：harness-core 与所有插件包禁止依赖 Electron；`harness-electron` 是唯一接触 Electron 的包。现有 IPC 契约（`src/shared/ipc.ts`）只增不改。

### 2.2 四个一等接口

```ts
// 模型接入：流式吐出文本增量 / 完整工具调用 / token 用量。
// tool call 的增量聚合在各 Provider 内部完成，对内核呈现为完整调用。
interface Provider {
  id: string;
  chat(req: ChatRequest): AsyncIterable<Delta>;
}

// 工具：JSON Schema 参数 + 执行器；readOnly 标记供计划模式判定。
interface Tool {
  name: string;
  description: string;
  readOnly: boolean;
  parameters: JsonSchema;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// 技能：描述常驻系统提示词索引表，正文只在被调用时加载，不常驻上下文。
interface Skill {
  name: string;
  description: string;
  loadBody(): Promise<string>;
}

// 权限规则：对一次工具调用给出判定。skip = 不表态。
interface PolicyRule {
  match(call: ToolCall): "allow" | "deny" | "skip";
}
```

### 2.3 规范消息模型（provider 无关）

```ts
type MessagePart =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; toolName: string; args: unknown }
  | { type: "toolResult"; toolCallId: string; content: string; isError?: boolean };

interface Message { role: "user" | "assistant"; parts: MessagePart[] }
```

工具结果以 `toolResult` part 挂在 **user** 角色消息上（Anthropic 风格）。各 Provider 负责映射到自家线格式（OpenAI 需拆成独立的 `role:"tool"` 消息）。这个选择让内核只有两种角色，配对校验简单。

### 2.4 AgentLoop（同步可读的核心循环）

```
用户输入 → provider.chat() 流式收集（文本增量 + 工具调用）
        → 逐个工具调用：权限判定 → 执行（超时/中止）→ 结果回填为 toolResult
        → 再次 chat → 直到本轮没有工具调用，产出最终回答
```

- 每步发出类型化事件：`turnStart` / `token` / `toolCall` / `permissionResolved` / `toolResult` / `compaction` / `error` / `done`。宿主只消费事件，内核不知道宿主存在。
- 轮数上限（默认 40）防失控；AbortSignal 贯穿 provider 请求与工具执行。
- 工具执行错误**不抛出中断循环**，而是作为 `isError: true` 的 toolResult 回喂模型，让它自行纠正。

### 2.5 插件机制（VS Code 风格）

每个插件导出 `activate(ctx: PluginContext)`，通过 `ctx.registerTool / registerProvider / registerSkill / registerPolicyRule / on(hook)` 注册。第一方插件（fs/shell/subagent/mcp/skills）与第三方插件走完全相同的注册路径——"万物皆插件"落在：**扩展点是内核唯一的开放面**。

### 2.6 上下文管理

字符数近似 token 估算（≈ chars/4）。超过会话配置阈值（默认 48000 token，即窗口 60000 的 80%）时自动压缩：把除最近 N=6 条消息外的历史序列化后请当前 Provider 总结为摘要，替换为一条摘要消息。压缩只发生在"安全边界"上——切点必须是纯 user 文本消息，保证 toolCall/toolResult 配对不被拆散。

### 2.7 权限引擎

判定管线（deny 规则始终最先短路，安全优先）：

```
① 任何 deny 规则命中 → DENY
② 模式 plan → readOnly ? ALLOW : DENY（告知模型"只能规划"）
③ 任何 allow 规则命中 → ALLOW
④ 模式 auto → ALLOW
⑤ 会话授权表命中 → ALLOW
⑥ → ASK（经注入的 PermissionDecider 弹出审批；测试中注入 mock 决策器）
```

- **项目规则**：项目根 `.innocence/config.json`，`allow`/`deny` 支持带参数匹配：`Bash(npm test)`（命令首词+子命令）、`Edit(src/**)`（路径 glob）；deny 优先于 allow。
- **会话授权**：用户选"本次允许"不记忆；"会话内总是允许"写入内存授权表（grant key：Bash 取首词，其余取工具名），会话结束失效。
- **路径安全**：Edit/Write 按工作区相对路径 glob 匹配，且强制解析后落在 `workspaceRoot` 内，路径逃逸（`../`、绝对路径越界、符号链接指向区外）直接 DENY。
- 决策器接口 `PermissionDecider.ask(call): Promise<"allow"|"allowSession"|"deny">`，由宿主注入（Electron 里桥到审批卡片 UI）。

## 3. 高阶插件设计

### 3.1 plugin-subagent（Task 工具）

注册 `Task` 工具，`execute()` 时在同进程内创建**嵌套 AgentSession**：独立消息历史（天然上下文隔离）、限定工具子集、独立系统提示词。父会话只拿到子 agent 的最终文本。内置 agent 类型起步：`explore`（只读工具集）与 `general`（全工具）。并发上限 3。**子会话的权限判定沿用同一引擎与同一决策器**——子 agent 想写文件照样走门控，不会绕过。

### 3.2 plugin-mcp

标准 MCP stdio 客户端（JSON-RPC 2.0 over stdin/stdout）。`activate()` 时按项目/用户配置逐个拉起外部 server，`initialize` 握手后拉取工具清单，把每个 MCP 工具包装成 harness Tool（命名 `mcp__服务器__工具`，readOnly 一律 false，权限默认 ask）。server 崩溃时对应工具标记不可用并作为错误结果告知模型，不拖垮主进程。

### 3.3 plugin-skills

扫描 `.innocence/skills/`（项目级）与用户级技能目录，解析 SKILL.md 的 YAML frontmatter（name/description）。技能**描述**常驻系统提示词（一张索引表），**正文**只在被调用（`/技能名` 或模型判断相关时由循环注入）时加载。与 ZCode/Claude Code 的 SKILL.md 格式同构，可直接复用现有技能文件。

### 3.4 provider-openai / provider-anthropic

原生 `fetch` + SSE 解析，不用上游 SDK。OpenAI：chat completions 流式（`tool_calls` 增量按 index 聚合，完整后一次性发出）。Anthropic：messages API（`content_block_delta` 聚合 `input_json_delta`）。API key、baseURL、model 经配置传入；OpenAI 兼容端点（国内模型、Ollama、vLLM）通过 baseURL 覆盖接入。

## 4. Electron 接入（harness-electron）

```
React UI ←→ IPC（现有契约 + 2 个新通道）←→ harness-electron ←→ AgentSession(内核)
                                                                ↘ 各插件
```

- 事件桥：内核事件 → 现有 `chat:delta/done/error` 通道；**现有 IPC 契约与 UI 基本不动**。
- 新增通道：`chat:permission`（审批卡片：工具名 + 参数摘要 + 本次允许/会话内允许/拒绝）与工作区文件夹选择。
- `mockAgent` 退役：`startStream` 调用点换为适配层；mock 保留为 provider-mock（测试与离线开发用）。
- 持久化：每会话一个 JSONL 文件（追加写）存于 Electron `userData`；`sessions.ts` 换文件实现、对外接口不变。

## 5. 里程碑（v1 内部构建顺序）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | 内核循环 + provider-mock + tools-fs + 权限引擎（纯 Node） | vitest 全绿：剧本化循环、权限全分支、临时目录文件工具 |
| M2 | provider-openai + provider-anthropic | 录制 SSE 夹具回放测试（纯文本/带工具/多工具/错误四种流） |
| M3 | harness-electron + 审批 UI + 工作区选择 + JSONL 持久化 | GUI 中完成一次真实小任务，全程流式 + 审批 |
| M4 | tools-shell + plugin-subagent + plugin-skills | 各插件单测 + 集成测试 |
| M5 | plugin-mcp | 对一个示例 MCP server 的握手/工具映射/崩溃隔离测试 |
| M6 | 自举验收 | 用 InnocenceCode+Harness 给 tools-fs 开发一个新工具并带测试 |

## 6. 测试与工程

- **测试**：vitest。Provider 用 SSE 夹具回放（无网络依赖）；循环用剧本化 Mock Provider 做确定性测试；权限引擎纯函数单测；tools-fs 在临时目录做真实文件测试。
- **底座**：npm workspaces 单仓 + git；包级 `tsc --noEmit` 干净、vitest 绿才进下一里程碑。
- **风险与对策**：
  - Electron 打包与 workspace 符号链接 → 适配层经 vite alias 直接引包源码，不进 node_modules 依赖图（M3 解决）。
  - 双协议流式细节差异 → 夹具回放测试先行，实现跟随测试。
  - 上下文压缩破坏工具配对 → 压缩只切在纯 user 文本消息边界，配对不变量有专门测试。

## 7. 明确不做（v1）

- 不做多用户/云端同步、遥测、自动更新。
- 不做插件市场与动态下载（插件是本地 npm 包/目录，加载即 activate）。
- 不做评测基准（SWE-bench 类）——自举即验收。
- SQLite 持久化（JSONL 够用，接口已为将来替换留好）。
