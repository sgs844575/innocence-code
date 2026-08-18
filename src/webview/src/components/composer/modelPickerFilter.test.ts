import { describe, expect, it } from "vitest";
import { filterProfiles } from "./modelPickerFilter";
import type { HarnessSettings } from "../../../../shared/ipc";

const settings = {
  profiles: [
    { id: "p1", name: "智谱", kind: "openai", apiKey: "", baseURL: "", enabled: true, preset: true,
      models: [{ id: "glm-4.6", source: "preset", tools: true }, { id: "glm-4.5-air", source: "preset" }] },
    { id: "p2", name: "DeepSeek", kind: "openai", apiKey: "", baseURL: "", enabled: false,
      models: [{ id: "deepseek-chat", source: "preset" }] },
  ],
} as unknown as HarnessSettings;

describe("modelPickerFilter", () => {
  it("只留启用的厂家", () => {
    expect(filterProfiles(settings, "")).toHaveLength(1);
  });
  it("搜索命中模型 id 时保留其厂家", () => {
    const hit = filterProfiles(settings, "deepseek");
    expect(hit).toHaveLength(0); // DeepSeek 未启用，不可见
  });
  it("搜索在启用厂家内命中模型", () => {
    const hit = filterProfiles(settings, "glm-4.5");
    expect(hit[0]!.models).toHaveLength(1);
  });
});
