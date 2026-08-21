import {
  appendSkillIndex,
  buildSkillIndex,
  type Skill,
} from "@innocencecode/harness-skills";
import { describe, expect, it } from "vitest";

const review: Skill = {
  name: "review",
  description: "代码审查指南",
  loadBody: async () => "审查正文内容",
};

describe("skills index (system-prompt segment)", () => {
  it("renders one `- name: description` line per skill", () => {
    expect(buildSkillIndex([review])).toBe("- review: 代码审查指南");
  });

  it("returns the empty string when no skill is registered", () => {
    expect(buildSkillIndex([])).toBe("");
  });

  it("returns the base prompt unchanged when no skill is registered", () => {
    expect(appendSkillIndex("base", [])).toBe("base");
  });

  it("appends the skills index table to the system prompt", () => {
    expect(appendSkillIndex("base", [review])).toBe(
      "base\n\n可用技能（用户以 /名称 调用；相关时你也可以建议）：\n- review: 代码审查指南",
    );
  });
});
