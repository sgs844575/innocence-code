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

describe("PROVIDER_PRESET_MIRROR 对齐 PROVIDER_PRESETS", () => {
  it("厂家集合一致（无缺漏、无多余）", () => {
    expect(PROVIDER_PRESET_MIRROR.map((p) => p.name)).toEqual(PROVIDER_PRESETS.map((p) => p.name));
  });
  it("每家 name/kind/baseURL/models 逐一相等", () => {
    expect(PROVIDER_PRESET_MIRROR).toEqual(PROVIDER_PRESETS);
  });
});

describe("shared 与包内 mock 常量对齐", () => {
  it("MOCK_PROFILE_ID / MOCK_MODEL 一致", () => {
    expect(MOCK_PROFILE_ID).toBe(PKG_MOCK_PROFILE_ID);
    expect(MOCK_MODEL).toBe(PKG_MOCK_MODEL);
  });
});
