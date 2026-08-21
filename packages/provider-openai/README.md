# provider-openai — OpenAI 兼容协议 Provider

`@innocencecode/provider-openai` 是 OpenAI 兼容 `chat/completions` 协议的原生 Provider 实现：
fetch + SSE 流式解析、`tool_calls` 增量聚合，把 wire 格式转换为 harness-core 的规范 `Delta` 流。
支持自定义 Base URL，因此 Ollama、vLLM 及各类网关等 OpenAI 兼容端点都能直接接入。

## 作用

- 请求映射：规范 `ChatRequest` → `chat/completions` body（`model / max_tokens / temperature / reasoning_effort`）。
- 流式解析：SSE data 行 → `openAIDeltasFromDataLines` 聚合出 text / toolCall 两种规范增量。
- API Key 取 `config.apiKey`，缺省回落环境变量 `OPENAI_API_KEY`；两者皆无时构造即抛错。

## 公开 API

| 导出 | 说明 |
|---|---|
| `createOpenAIProvider(config)` | 构造 `Provider`（id 默认 `openai`） |
| `createOpenAIPlugin(config)` | 内核插件（name `provider-openai`）：`apply(ctx)` 时 `ctx.providers.register(...)` |
| `toOpenAIBody` | 请求映射（导出供测试回放） |
| `openAIDeltasFromDataLines` | SSE 增量聚合（导出供测试回放） |

`OpenAIProviderConfig`：`apiKey? / baseURL? / model / maxTokens? / temperature? / reasoningEffort? / id? / fetchImpl?`。
`baseURL` 默认 `https://api.openai.com/v1`（尾部斜杠自动去除）；`fetchImpl` 供测试注入。

## 使用

```ts
import { createOpenAIProvider } from "@innocencecode/provider-openai";

const provider = createOpenAIProvider({
  apiKey: "sk-…",
  model: "gpt-4.1",
  // baseURL: "http://localhost:11434/v1",  // OpenAI 兼容端点（本地推理/网关）
});

// 直接作为 Provider 用，或经内核插件注册（providers 服务面）：
import { createOpenAIPlugin } from "@innocencecode/provider-openai";
plugins.push(createOpenAIPlugin({ apiKey: "sk-…", model: "gpt-4.1" }));
```

桌面宿主里由组合层（`src/main/harnessGlue.ts`）按当前设置构造实例并包成 provider 插件入组合集（设置界面可填
API Key 与 Base URL，Key 仅存本机）。

## 关键行为与约束

- 非 2xx 响应抛 `OpenAI HTTP <status>` 并附响应体前 300 字符；无 body 抛错。
- 请求 signal（用户停止）直接传导到 fetch，中断流。
- 思考档位 `reasoningEffort`（`low/medium/high` 等）：`off` 或不传则不带该参数。
- Provider 转换属于本包职责——规范消息里不出现任何 wire 字段（harness-core 协议中立约束）。

## 测试

```bash
npx vitest run packages/provider-openai
```

`tests/openai.test.ts`（协议细节）与 `tests/provider.test.ts`（夹具回放）。
