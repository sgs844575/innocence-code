// Provider construction from settings (split from runtime.ts by
// responsibility): resolves the active profile and instantiates the matching
// provider, falling back to the offline mock provider.
import { createMockProvider } from "@innocencecode/provider-mock";
import { createOpenAIProvider } from "@innocencecode/provider-openai";
import { createAnthropicProvider } from "@innocencecode/provider-anthropic";
import { MOCK_GREETING, resolveActive, type HarnessSettings } from "./settings";

export function buildProviderFromSettings(settings: HarnessSettings) {
  const active = resolveActive(settings);
  // 空串 = 跟随模型默认（不传参）；off 交给 provider 层解释（openai 省略、anthropic 不开启）。
  const reasoningEffort = settings.reasoningEffort || undefined;
  switch (active.kind) {
    case "openai":
      return createOpenAIProvider({
        apiKey: active.apiKey || undefined,
        baseURL: active.baseURL || undefined,
        model: active.model,
        reasoningEffort,
      });
    case "anthropic":
      return createAnthropicProvider({
        apiKey: active.apiKey || undefined,
        model: active.model,
        reasoningEffort,
      });
    default:
      return createMockProvider({ id: "mock", turns: [], exhaustedText: MOCK_GREETING });
  }
}
