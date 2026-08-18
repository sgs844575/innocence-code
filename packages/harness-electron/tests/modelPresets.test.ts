// packages/harness-electron/tests/modelPresets.test.ts
import { describe, expect, it } from "vitest";
import { PRESET_MODELS, modelFromPreset, resolvePresetMeta } from "../src/modelPresets";

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

describe("cherry registry 适配层", () => {
  it("cherry 规范模型路径（ownedBy 归属）", () => {
    // cherry 条目（不在 MANUAL 里）：claude-3-haiku = 200K / 4K 输出 / function-call+image-recognition
    const meta = resolvePresetMeta("Anthropic", "claude-3-haiku");
    expect(meta).toMatchObject({ contextWindow: 200000, maxOutput: 4096, tools: true, vision: true });
  });
  it("cherry 别名路径（API 原始 id → 规范 id，网关厂商）", () => {
    const or = PRESET_MODELS["OpenRouter"] ?? {};
    const aliasIds = Object.keys(or).filter((id) => id.includes("/"));
    expect(aliasIds.length).toBeGreaterThan(10); // OpenRouter 的 337 条别名已并入
    const withCtx = aliasIds.find((id) => or[id]?.contextWindow != null);
    expect(withCtx).toBeDefined();
    expect(resolvePresetMeta("OpenRouter", "openai/gpt-5")?.contextWindow).toBe(400000);
  });
  it("批量规模：12 家全部有数据，量大厂不为空", () => {
    const counts = Object.entries(PRESET_MODELS).map(([name, t]) => [name, Object.keys(t).length]);
    expect(counts.length).toBe(12);
    for (const [, n] of counts) expect(n).toBeGreaterThan(0);
    expect(Object.keys(PRESET_MODELS["智谱开放平台"] ?? {}).length).toBeGreaterThanOrEqual(37);
    expect(Object.keys(PRESET_MODELS["Gemini"] ?? {}).length).toBeGreaterThanOrEqual(50); // google 厂牌 70 条
    expect(Object.keys(PRESET_MODELS["xAI"] ?? {}).length).toBeGreaterThanOrEqual(30); // xai 厂牌 34 条
    expect(Object.keys(PRESET_MODELS["阿里云百炼"] ?? {}).length).toBeGreaterThanOrEqual(80); // alibaba 110 条
  });
  it("归一化模糊回退：点风格 API id 命中连字符规范条目", () => {
    // cherry 规范 id 是 gemini-2-0-flash-lite；API 原始 id gemini-2.0-flash-lite
    // 不在手工层，只能经点→连字符归一化命中
    const meta = resolvePresetMeta("Gemini", "gemini-2.0-flash-lite");
    expect(meta?.contextWindow).toBeGreaterThan(0);
  });
  it("厂家无关全局回退：中转站（任意厂家名）下的任何家模型 id 都能命中", () => {
    expect(resolvePresetMeta("我的中转站", "gpt-5")?.contextWindow).toBe(400000);
    expect(resolvePresetMeta("我的中转站", "claude-sonnet-4-5")?.tools).toBe(true);
    expect(resolvePresetMeta("自定义网关", "deepseek-chat")?.contextWindow).toBeGreaterThan(0);
  });
  it("reasoningEfforts 从 cherry reasoning 元数据提取", () => {
    // 走全局路径（中转站名）拿 cherry 原始条目——厂家表里的 gpt-5 是手工层
    // （无 efforts 字段），恰好同时验证"手工层只覆盖自己声明的字段"这一事实。
    const meta = resolvePresetMeta("我的中转站", "gpt-5");
    expect(meta?.reasoning).toBe(true);
    expect(meta?.reasoningEfforts).toContain("high");
    expect(meta?.reasoningEfforts).toContain("minimal");
  });
  it("手工层优先于 cherry 数据", () => {
    // MANUAL 的 sonnet-4-5 maxOutput=32000，cherry 规范值是 64000——手工层必须赢
    expect(resolvePresetMeta("Anthropic", "claude-sonnet-4-5")?.maxOutput).toBe(32000);
  });
});
