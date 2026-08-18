import { describe, expect, it } from "vitest";
import { mergeSync } from "./mergeSync";
import type { ModelInfo } from "../../../../../shared/ipc";

const m = (id: string, over: Partial<ModelInfo> = {}): ModelInfo => ({ id, source: "preset", ...over });

/** 第四参注入的预设元数据 stub：glm-4.6 / glm-4.5-air 带元数据，其余退化为最小对象。 */
const modelFromPresetStub = (providerName: string, id: string): ModelInfo => {
  void providerName;
  if (id === "glm-4.6")
    return { id, source: "preset", name: "GLM-4.6", group: "chat", contextWindow: 200000, maxOutput: 8192, tools: true };
  if (id === "glm-4.5-air")
    return { id, source: "preset", contextWindow: 128000, maxOutput: 4096, tools: true };
  return { id, source: "fetch" };
};

describe("mergeSync", () => {
  it("新增：拉回且不存在 → added（带预设元数据）", () => {
    const r = mergeSync([m("a")], ["a", "glm-4.6"], "智谱开放平台", modelFromPresetStub);
    expect(r.added.map((x) => x.id)).toEqual(["glm-4.6"]);
    expect(r.added[0]!.contextWindow).toBeGreaterThan(0);
  });
  it("移除：本地有且拉回没有 → removed；dirty 的除外", () => {
    const r = mergeSync([m("a"), m("b", { dirty: true })], ["a"], "X", modelFromPresetStub);
    expect(r.removed.map((x) => x.id)).toEqual([]);
    // "除外"= 存活：dirty 且未拉回的模型必须落在 kept，否则应用
    // 全部变更（models = kept + added）会把它静默删除。
    expect(r.kept.map((x) => x.id)).toEqual(["a", "b"]);
    const r2 = mergeSync([m("a"), m("c")], ["a"], "X", modelFromPresetStub);
    expect(r2.removed.map((x) => x.id)).toEqual(["c"]);
  });
  it("保留：交集原样（不覆盖任何字段）", () => {
    const r = mergeSync(
      [m("a", { contextWindow: 999, dirty: true })],
      ["a"],
      "DeepSeek",
      modelFromPresetStub,
    );
    expect(r.kept[0]!.contextWindow).toBe(999);
    expect(r.added).toHaveLength(0);
  });
  // 规格 §4.4 enrich 规则：只填空缺字段、不覆盖已有值、dirty 完全不动。
  it("kept 逐字段 enrich：无元数据的 kept 模型空缺字段被预设填充", () => {
    const r = mergeSync(
      [m("glm-4.5-air", { source: "fetch" })],
      ["glm-4.5-air"],
      "智谱开放平台",
      modelFromPresetStub,
    );
    expect(r.kept[0]).toMatchObject({
      id: "glm-4.5-air",
      source: "fetch",
      contextWindow: 128000,
      maxOutput: 4096,
      tools: true,
    });
  });
  it("kept 逐字段 enrich：已有字段不被预设覆盖，仅空缺被填", () => {
    const r = mergeSync(
      [m("glm-4.6", { name: "自定义名", contextWindow: 999 })],
      ["glm-4.6"],
      "智谱开放平台",
      modelFromPresetStub,
    );
    expect(r.kept[0]!.name).toBe("自定义名");
    expect(r.kept[0]!.contextWindow).toBe(999);
    expect(r.kept[0]!.group).toBe("chat");
    expect(r.kept[0]!.maxOutput).toBe(8192);
    expect(r.kept[0]!.tools).toBe(true);
  });
  it("kept 逐字段 enrich：dirty 模型完全不动", () => {
    const r = mergeSync(
      [m("glm-4.5-air", { dirty: true, source: "manual" })],
      ["glm-4.5-air"],
      "智谱开放平台",
      modelFromPresetStub,
    );
    expect(r.kept[0]!.contextWindow).toBeUndefined();
    expect(r.kept[0]!.tools).toBeUndefined();
    expect(r.kept[0]!.dirty).toBe(true);
  });
});
