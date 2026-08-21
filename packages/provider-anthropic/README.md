# provider-anthropic — Anthropic messages 协议 Provider

`@innocencecode/provider-anthropic` 是 Anthropic `v1/messages` 协议的原生 Provider 实现：
fetch + SSE 流式解析、`tool_use` 内容块增量聚合，把 wire 格式转换为 harness-core 的规范 `Delta` 流。

## 作用

- 请求映射：规范 `ChatRequest` → `v1/messages` body（`model / max_tokens / temperature / thinking`）；
  思考档位 `reasoningEffort`（`low/medium/high`）映射为 thinking budget，`off` 或不传则不开启。
- 流式解析：SSE 事件 → `anthropicDeltasFromDataLines` 聚合出 text / toolCall 增量。
- 请求头带 `x-api-key` 与 `anthropic-version: 2023-06-01`；API Key 取 `config.apiKey`，
  缺省回落环境变量 `ANTHROPIC_API_KEY`，两者皆无时构造即抛错。

## 公开 API

| 导出 | 说明 |
|---|---|
| `createAnthropicProvider(config)` | 构造 `Provider`（id 默认 `anthropic`） |
| `anthropicPlugin(config)` | 插件包装：`activate(ctx)` 时 `ctx.registerProvider(...)`（name `provider-anthropic`） |
| `toAnthropicBody` | 请求映射（导出供测试回放） |
| `anthropicDeltasFromDataLines` | SSE 增量聚合（导出供测试回放） |

`AnthropicProviderConfig`：`apiKey? / baseURL? / model / maxTokens? / temperature? / reasoningEffort? / id? / fetchImpl?`。
`baseURL` 默认 `https://api.anthropic.com`；`fetchImpl` 供测试注入。

## 使用

```ts
import { createAnthropicProvider } from "@innocencecode/provider-anthropic";

const provider = createAnthropicProvider({ apiKey: "sk-ant-…", model: "claude-sonnet-4" });

// 直接作为 Provider 用，或经插件注册：
import { anthropicPlugin } from "@innocencecode/provider-anthropic";
plugins.push(anthropicPlugin({ apiKey: "sk-ant-…", model: "claude-sonnet-4" }));
```

桌面宿主里由 `harness-electron` 的 `buildProviderFromSettings(settings)` 按当前设置实例化。

## 关键行为与约束

- 非 2xx 响应抛 `Anthropic HTTP <status>` 并附响应体前 300 字符；无 body 抛错。
- 请求 signal（用户停止）直接传导到 fetch，中断流。
- Provider 转换属于本包职责——规范消息里不出现任何 wire 字段（harness-core 协议中立约束）。

## 测试

```bash
npx vitest run packages/provider-anthropic
```

`tests/anthropic.test.ts`（协议细节）与 `tests/provider.test.ts`（夹具回放）。
