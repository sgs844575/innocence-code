// 字典完整性：zh/en 键集必须一致（缺键静默回落英文会造成半翻译 UI）；
// agent=plan 与权限模式 plan 的语义区分文案必须成对存在（spec 2.2）。
import { describe, expect, it } from "vitest";
import { enUS, zhCN } from "./i18n";

describe("i18n dictionaries", () => {
  it("zh/en 键集完全一致", () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(zhCN).sort());
  });

  it("agent.plan 保持显示名“计划”，且与权限模式 plan 的描述措辞区分", () => {
    expect(zhCN["agent.plan"]).toBe("计划");
    expect(zhCN["agent.plan.desc"]).toContain("提示词级");
    expect(zhCN["agent.plan.desc"]).not.toBe(zhCN["permission.mode.plan.desc"]);
    expect(enUS["agent.plan.desc"]).not.toBe(enUS["permission.mode.plan.desc"]);
  });
});
