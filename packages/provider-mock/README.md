# provider-mock — 剧本化 Mock Provider

`@innocencecode/provider-mock` 提供可编剧本的假 Provider：按顺序回放预设的模型回合（文本 / 工具调用），
用于离线开发 harness 与测试（不依赖任何网络与真实 API Key）。

## 作用

- **剧本回放**：`turns` 数组逐回合消耗，每回合可含 `text` 与若干 `toolCalls`；文本按 `chunkSize` 切成增量模拟流式。
- **压缩旁路**：收到压缩摘要请求（harness-core 的 `SUMMARIZE_SYSTEM_PROMPT`）时直接返回 `summarizeResponse`，
  主循环剧本保持线性。
- **剧本耗尽**：返回 `exhaustedText`（默认 `[mock] 剧本已播完。`）。
- **观测缝**：`onChat` 回调收到每个请求，供断言请求内容。

## 公开 API

| 导出 | 说明 |
|---|---|
| `createMockProvider(opts)` | 构造 `Provider`（id 默认 `mock`） |
| `createMockPlugin(opts)` | 内核插件（name `provider-mock`）：`apply(ctx)` 时 `ctx.providers.register(...)` |
| `MockTurn` | `{ text?, toolCalls?: MockToolCall[] }`，`MockToolCall = { toolName, args? }` |
| `MockProviderOptions` | `turns`（必填）、`id? / chunkSize?（默认 4）/ delayMs?（默认 0）/ summarizeResponse? / exhaustedText? / onChat?` |

## 使用

```ts
import { createMockProvider } from "@innocencecode/provider-mock";

const provider = createMockProvider({
  turns: [
    { toolCalls: [{ toolName: "Read", args: { path: "src/a.ts" } }] },
    { text: "读完了，文件共 42 行。" },
  ],
  onChat: (req) => console.log("chat 请求工具数:", req.tools.length),
});

// 喂给 AgentSession.create({ provider, ... }) 即可离线跑完整 Agent 循环
```

桌面宿主把它作为默认 Provider（`harness-electron` 设置里的 `__mock__` profile）——首次启动无 Key 时也能体验完整流程。

## 关键行为与约束

- 剧本一次性顺序消费（游标只前进），适合确定性测试；需要多轮同剧本请重建 provider。
- 工具调用 id 自动编号（`call_1`、`call_2`…），与真实协议的 id 语义一致。

## 测试

```bash
npx vitest run packages/provider-mock
```

`tests/mock.test.ts` 覆盖回放顺序、流式切块、压缩旁路与耗尽行为。
