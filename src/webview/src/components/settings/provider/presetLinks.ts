// 预设厂家的外链与官方 API 地址。键与 harness-electron PROVIDER_PRESETS
// 的厂家名一一对应（packages/harness-electron/src/settings.ts）。
export interface PresetLink {
  baseURL: string;
  website?: string;
  apiKeyWebsite?: string;
}

export const PRESET_LINKS: Record<string, PresetLink> = {
  OpenAI: { baseURL: "", website: "https://openai.com", apiKeyWebsite: "https://platform.openai.com/api-keys" },
  Anthropic: { baseURL: "", apiKeyWebsite: "https://console.anthropic.com/settings/keys" },
  DeepSeek: { baseURL: "https://api.deepseek.com/v1", apiKeyWebsite: "https://platform.deepseek.com" },
  硅基流动: { baseURL: "https://api.siliconflow.cn/v1", apiKeyWebsite: "https://cloud.siliconflow.cn" },
  OpenRouter: { baseURL: "https://openrouter.ai/api/v1", apiKeyWebsite: "https://openrouter.ai/settings/keys" },
  智谱开放平台: { baseURL: "https://open.bigmodel.cn/api/paas/v4", apiKeyWebsite: "https://open.bigmodel.cn/usercenter/apikeys" },
  Moonshot: { baseURL: "https://api.moonshot.cn/v1", apiKeyWebsite: "https://platform.moonshot.cn/console/api-keys" },
  "Ollama 本地": { baseURL: "http://localhost:11434/v1" },
};

export const presetFor = (name: string): PresetLink | undefined => PRESET_LINKS[name];
