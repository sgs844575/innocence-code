// profileOps 纯变换单测——原 SettingsView 内联闭包逻辑提纯后的行为锚点。
import { describe, expect, it } from "vitest";
import {
  applyModelPatch,
  applySyncPlan,
  duplicateProfile,
  presetModelLookup,
  removeProfile,
  reorderProfiles,
} from "./profileOps";
import {
  MOCK_MODEL,
  MOCK_PROFILE_ID,
  type HarnessSettings,
  type ModelInfo,
  type ProviderProfile,
} from "../../../../../shared/ipc";

const model = (id: string, over: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  source: "preset",
  ...over,
});
const profile = (id: string, over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  id,
  name: id,
  kind: "openai",
  apiKey: "",
  baseURL: "",
  enabled: true,
  models: [],
  ...over,
});
const settings = (
  profiles: ProviderProfile[],
  activeProfileId = MOCK_PROFILE_ID,
): HarnessSettings => ({
  profiles,
  activeProfileId,
  activeModel: MOCK_MODEL,
  workspaceRoot: "",
  permissionMode: "ask",
});

describe("reorderProfiles", () => {
  it("按 ids 重排（全量覆盖才生效）", () => {
    const a = profile("a");
    const b = profile("b");
    expect(reorderProfiles([a, b], ["b", "a"])).toEqual([b, a]);
  });
  it("ids 缺漏或含重复 → null 不落库（防半写）", () => {
    const a = profile("a");
    const b = profile("b");
    expect(reorderProfiles([a, b], ["a"])).toBeNull();
    expect(reorderProfiles([a, b], ["a", "a"])).toBeNull();
  });
});

describe("duplicateProfile", () => {
  it("深拷贝：副本模型不是原对象，改副本不影响原件", () => {
    const src = profile("a", { preset: true, models: [model("m1", { contextWindow: 8 })] });
    const out = duplicateProfile([src, profile("b")], "a", () => "new_id");
    expect(out).toHaveLength(3);
    const copy = out![1]!;
    expect(copy.id).toBe("new_id");
    expect(copy.name).toBe("a 副本");
    expect(copy.preset).toBe(false);
    expect(copy.models[0]).not.toBe(src.models[0]);
    copy.models[0]!.contextWindow = 999;
    expect(src.models[0]!.contextWindow).toBe(8);
  });
  it("插在原 profile 之后", () => {
    const out = duplicateProfile([profile("a"), profile("b")], "a", () => "c");
    expect(out!.map((p) => p.id)).toEqual(["a", "c", "b"]);
  });
  it("未知 id → null", () => {
    expect(duplicateProfile([profile("a")], "x", () => "c")).toBeNull();
  });
});

describe("removeProfile", () => {
  it("删除非激活：激活态不动", () => {
    const a = profile("a");
    const b = profile("b");
    const next = removeProfile(settings([a, b], "b"), "a");
    expect(next.profiles).toEqual([b]);
    expect(next.activeProfileId).toBe("b");
    expect(next.activeModel).toBe(MOCK_MODEL);
  });
  it("删除激活：回落 mock", () => {
    const next = removeProfile(settings([profile("a"), profile("b")], "a"), "a");
    expect(next.profiles.map((p) => p.id)).toEqual(["b"]);
    expect(next.activeProfileId).toBe(MOCK_PROFILE_ID);
    expect(next.activeModel).toBe(MOCK_MODEL);
  });
});

describe("applyModelPatch", () => {
  it("新建未定 id：只累积进 editing，不落库", () => {
    const r = applyModelPatch([model("m1")], model("", { source: "manual" }), { name: "草稿" });
    expect(r.models).toBeNull();
    expect(r.editing).toEqual({ id: "", source: "manual", name: "草稿" });
  });
  it("新建首个带 id patch：以 manual 落库并切换 editing 到已插入对象", () => {
    const r = applyModelPatch(
      [model("m1")],
      model("", { source: "manual", name: "草稿" }),
      { id: "m2", contextWindow: 128000 },
    );
    expect(r.models).toEqual([
      model("m1"),
      model("m2", { source: "manual", name: "草稿", contextWindow: 128000 }),
    ]);
    expect(r.editing).toBe(r.models![1]);
  });
  it("已有模型：patch 原位合并，其余条目不动", () => {
    const r = applyModelPatch(
      [model("m1", { contextWindow: 8 }), model("m2")],
      model("m1", { contextWindow: 8 }),
      { contextWindow: 999, dirty: true },
    );
    expect(r.models).toEqual([model("m1", { contextWindow: 999, dirty: true }), model("m2")]);
  });
});

describe("applySyncPlan", () => {
  it("常规形态：models = kept + added（保序）", () => {
    const kept = [model("a"), model("b")];
    const added = [model("c")];
    expect(applySyncPlan({ kept, removed: [], added })).toEqual([...kept, ...added]);
  });
  it("全部添加形态：removed 并入 kept、added 清空 → 不丢任何模型", () => {
    const removed = [model("x"), model("y")];
    const kept = [model("a"), ...removed];
    expect(applySyncPlan({ kept, removed, added: [] })).toEqual([model("a"), model("x"), model("y")]);
  });
});

describe("presetModelLookup", () => {
  it("命中返回预取元数据，未命中退化为最小 fetch 对象", () => {
    const lookup = presetModelLookup([model("glm-4.6", { contextWindow: 200000 })]);
    expect(lookup("智谱开放平台", "glm-4.6").contextWindow).toBe(200000);
    expect(lookup("智谱开放平台", "unknown")).toEqual({ id: "unknown", source: "fetch" });
  });
});
