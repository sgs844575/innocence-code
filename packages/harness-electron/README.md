# harness-electron — Electron 宿主的 Agent 运行时适配层

`@innocencecode/harness-electron` 是 harness-core 会话与 Electron 宿主之间的运行时胶水：
按聊天路由（`sessionId:routeId`）持有/重建 `AgentSession`，把 harness 事件翻译为宿主流式 UI 钩子，
并负责设置持久化、Provider 构建、会话转录（JSONL）与内置代理提示词。
包本身不 import 任何 Electron API——UI 桥全部经注入的 `RuntimeHooks` 端口，因此可在 Node 测试中直接运行。

## 作用

- **HarnessRuntime**：`send(request)` 跑一轮对话（事件转发 + 结束后 `persistTurn` 落盘）；`stop` 中止；
  `dispose/disposeAll` 释放（中止运行 + 释放插件，永不 reject）；`forkRoute` 委托宿主端口实现路由分叉。
- **路由会话缓存**：`RouteSessionCache` 处理构建去重与 dispose/build 竞态（墓碑状态机，dispose 期间落地的新会话就地释放）。
- **设置**：`HarnessSettings`（v3 多平台 profile）、防御性归一化 `mergeSettings`（v1/v2 旧格式自动迁移）、
  内置 12 个平台预设、`resolveActive` 解析当前 Provider+模型（回落 mock）、`listModels` 拉取模型列表。
- **Provider 构建**：已迁宿主组合层（`src/main/harnessGlue.ts`）——本包不再实例化 Provider，会话 provider 一律经 providers 注册表解析。
- **内置代理**：`default / plan / full` 三档系统提示词（`systemPromptFor`），与 IPC 共享类型镜像测试防漂移。
- **转录**：`encodeTurnV2/V3` + `decodeTranscript`（v2 行与 legacy 快照归入 main 路由；v3 行按 routeId 建路由图）、
  `canonicalizeHistory`（UI 形态 → 规范 harness 形态，未知合法 part 原样保留）。
- **模型预设**：本地打包的模型目录数据 + 厂家无关五级回退解析（`resolvePresetMeta` / `modelFromPreset`）。

## 公开 API（节选）

| 导出 | 说明 |
|---|---|
| `HarnessRuntime` | 路由会话运行时（`send / stop / dispose / disposeAll / forkRoute`） |
| `RuntimeOptions` / `RuntimeHooks` | 宿主注入面（settings / pluginsForSession / workspaceRootFor / persistDir）与 UI 钩子（onDelta / onTool / onThinking / onCompleted / onError / askPermission / log） |
| `DEFAULT_ROUTE_ID` | 缺省路由 id `"main"` |
| `DEFAULT_SETTINGS` / `mergeSettings` / `resolveActive` / `listModels` / `PROVIDER_PRESETS` | 设置体系 |
| `AGENT_IDS` / `BUILTIN_AGENTS` / `systemPromptFor` | 内置代理提示词 |
| `encodeTurnV2` / `encodeTurnV3` / `decodeTranscript` / `canonicalizeHistory` | 转录编解码 |
| `routeCacheKey` | `sessionId:routeId` 规范键 |

## 使用

```ts
import { HarnessRuntime, mergeSettings } from "@innocencecode/harness-electron";

const runtime = new HarnessRuntime({
  settings: () => currentSettings,          // 设置变化（JSON 序列化比较）触发会话重建
  persistDir: path.join(userData, "transcripts"),
  workspaceRootFor: (ctx) => resolveRouteRoot(ctx), // 任务路由的 worktree 优先
  pluginsForSession: (ctx) => composePlugins(ctx),  // 宿主组合根决定插件集
  hooks: {
    onDelta: (id, routeId, text) => win.webContents.send("chat:delta", { id, routeId, text }),
    askPermission: async (ask) => showPermissionCard(ask), // 审批桥
    // onTool / onThinking / onCompleted / onError / log …
  },
});

const result = await runtime.send({ sessionId, routeId, text: "帮我看看构建为什么挂了" });
```

实际接线在 `src/main/harnessGlue.ts`（组合根）与 `src/main/ipc.ts`（IPC 通道注册）。

## 关键行为与约束

- 会话重建：设置序列化结果变化即重建，重建时先拷贝旧 history 再释放旧会话；重启仅 main 路由从转录回填 history。
- `persistTurn` 跳过任务轮次（taskId 非空，任务侧自行提交 turn-v3 行）；持久化 best-effort，失败仅告警。
- 权限审计：每次判定经 `hooks.log` 输出，raw 参数不达宿主面。
- 默认设置：`activeProfileId = "__mock__"`、`permissionMode = "ask"`、`activeAgent = "default"`。

## 测试

```bash
npx vitest run packages/harness-electron
```

`tests/`：运行时、设置、转录、内置代理、模型预设、IPC 镜像防漂移，以及自举验收替身 `bootstrap.test.ts`
（完整运行时 + 真实文件工具 + shell + 审批门控跑通"读 → 改 → 写 → 验证"）。
