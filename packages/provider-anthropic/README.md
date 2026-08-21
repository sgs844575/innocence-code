# provider-anthropic — Anthropic messages 协议 Provider

`@innocencecode/provider-anthropic` 是 Anthropic `v1/messages` 协议的原生 Provider 实现：
fetch + SSE 流式解析、`tool_use` 内容块增量聚合，把 wire 格式转换为 `harness-providers` 的规范 `Delta` 流。

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
| `createAnthropicPlugin(config)` | 内核插件（name `provider-anthropic`）：`apply(ctx)` 时 `ctx.providers.register(...)` |
| `toAnthropicBody` | 请求映射（导出供测试回放） |
| `anthropicDeltasFromDataLines` | SSE 增量聚合（导出供测试回放） |

`AnthropicProviderConfig`：`apiKey? / baseURL? / model / maxTokens? / temperature? / reasoningEffort? / id? / fetchImpl?`。
`baseURL` 默认 `https://api.anthropic.com`；`fetchImpl` 供测试注入。

## 使用

```ts
import { createAnthropicProvider } from "@innocencecode/provider-anthropic";

const provider = createAnthropicProvider({ apiKey: "sk-ant-…", model: "claude-sonnet-4" });

// 直接作为 Provider 用，或经内核插件注册（providers 服务面）：
import { createAnthropicPlugin } from "@innocencecode/provider-anthropic";
plugins.push(createAnthropicPlugin({ apiKey: "sk-ant-…", model: "claude-sonnet-4" }));
```

桌面宿主里由组合层（`src/main/harnessGlue.ts`）按当前设置构造实例并包成 provider 插件入组合集。

## 关键行为与约束

- 非 2xx 响应抛 `Anthropic HTTP <status>` 并附响应体前 300 字符；无 body 抛错。
- 请求 signal（用户停止）直接传导到 fetch，中断流。
- Provider 转换属于本包职责——规范消息里不出现任何 wire 字段（providers 脊柱协议中立约束）。

## 测试

```bash
npx vitest run packages/provider-anthropic
```

`tests/anthropic.test.ts`（协议细节）与 `tests/provider.test.ts`（夹具回放）。
