// Drift guard：shared 的 PROVIDER_PRESET_MIRROR 必须与 harness-electron 的
// PROVIDER_PRESETS 逐家对齐（渲染层无法 import node 侧包，镜像一旦漂移，
// AddProviderDialog 展示/创建的预设就会与出厂默认不一致）。
import { describe, expect, it } from "vitest";
import {
  MOCK_MODEL,
  MOCK_PROFILE_ID,
  PROVIDER_PRESET_MIRROR,
} from "../../../src/shared/ipc";
import {
  MOCK_MODEL as PKG_MOCK_MODEL,
  MOCK_PROFILE_ID as PKG_MOCK_PROFILE_ID,
  PROVIDER_PRESETS,
} from "../src/settings";
import { PRESET_MODELS } from "../src/modelPresets";

describe("PROVIDER_PRESET_MIRROR 对齐 PROVIDER_PRESETS", () => {
  it("厂家集合一致（无缺漏、无多余）", () => {
    expect(PROVIDER_PRESET_MIRROR.map((p) => p.name)).toEqual(PROVIDER_PRESETS.map((p) => p.name));
  });
  it("每家 name/kind/baseURL/models 逐一相等", () => {
    expect(PROVIDER_PRESET_MIRROR).toEqual(PROVIDER_PRESETS);
  });
});

describe("PRESET_MODELS 键对齐 PROVIDER_PRESETS", () => {
  it("元数据键 ⊆ 预设厂家名（键拼错 = enrich 永远 miss）", () => {
    const names = new Set(PROVIDER_PRESETS.map((p) => p.name));
    for (const key of Object.keys(PRESET_MODELS)) {
      expect(names.has(key), `PRESET_MODELS 键 "${key}" 不在任何预设厂家名里`).toBe(true);
    }
  });
  it("每家预设 seed 模型都有元数据（seed 无元数据 = 出厂裸模型）", () => {
    for (const preset of PROVIDER_PRESETS) {
      const meta = PRESET_MODELS[preset.name] ?? {};
      for (const id of preset.models) {
        expect(meta[id], `${preset.name} 的 seed 模型 "${id}" 缺元数据`).toBeDefined();
      }
    }
  });
});

describe("shared 与包内 mock 常量对齐", () => {
  it("MOCK_PROFILE_ID / MOCK_MODEL 一致", () => {
    expect(MOCK_PROFILE_ID).toBe(PKG_MOCK_PROFILE_ID);
    expect(MOCK_MODEL).toBe(PKG_MOCK_MODEL);
  });
});
