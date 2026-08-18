// packages/harness-electron/tests/modelPresets.test.ts
import { describe, expect, it } from "vitest";
import { modelFromPreset, resolvePresetMeta } from "../src/modelPresets";

describe("模型预设元数据", () => {
  it("按厂家+模型 id 命中元数据", () => {
    const meta = resolvePresetMeta("智谱开放平台", "glm-4.6");
    expect(meta?.contextWindow).toBeGreaterThan(0);
  });
  it("未命中返回 undefined", () => {
    expect(resolvePresetMeta("智谱开放平台", "no-such-model")).toBeUndefined();
  });
  it("modelFromPreset 落库为 preset 来源", () => {
    const m = modelFromPreset("DeepSeek", "deepseek-chat");
    expect(m).toMatchObject({ id: "deepseek-chat", source: "preset", tools: true });
    expect(m.contextWindow).toBeGreaterThan(0);
  });
  it("无元数据的 id 生成最小对象", () => {
    const m = modelFromPreset("DeepSeek", "whatever");
    expect(m).toEqual({ id: "whatever", source: "preset" });
  });
});
