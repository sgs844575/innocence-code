# presets/ — cherry-studio registry 裁剪本

来源：[cherry-studio](https://github.com/CherryHQ/cherry-studio) 的 `packages/provider-registry`（**MIT 许可**）编译产物，裁剪到本项目 `PROVIDER_PRESETS` 覆盖的 12 家厂商。

- `models.json` — 规范模型表（含闭包：别名引用到的其他家规范条目也保留）
- `provider-models.json` — 厂商别名表（API 原始 id → cherry 规范 id）

## 再生成

cherry-studio 升级后重跑（保留 12 家 + 闭包，别名条目只留 providerId/modelId/apiModelId/name）：

```js
// node，在 cherry-studio 仓库根执行；KEEP 为 cherry 厂商 id
const KEEP = ["openai","anthropic","deepseek","gemini","dashscope","zhipu","moonshot","grok","mistral","silicon","openrouter","ollama"];
```

映射关系（我们的厂家名 → cherry id）见 `src/modelPresets.ts` 的 `CHERRY_PROVIDER`。厂商名与 id 的对应、以及"每个预设 seed 模型必须有元数据"由 `tests/mirror.test.ts` 的 drift-guard 钉住。
