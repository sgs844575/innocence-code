import { describe, expect, it } from "vitest";
import { mergeSync } from "./mergeSync";
import type { ModelInfo } from "../../../../../shared/ipc";

const m = (id: string, over: Partial<ModelInfo> = {}): ModelInfo => ({ id, source: "preset", ...over });

/** 第四参注入的预设元数据 stub：glm-4.6 带上下文窗口，其余退化为最小对象。 */
const modelFromPresetStub = (providerName: string, id: string): ModelInfo => {
  void providerName;
  return id === "glm-4.6"
    ? { id, source: "preset", contextWindow: 200000 }
    : { id, source: "fetch" };
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
});
