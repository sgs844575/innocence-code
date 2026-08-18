import { describe, expect, it } from "vitest";
import { groupModels, modelGroupName } from "./modelGrouping";
import type { ModelInfo } from "../../../../../shared/ipc";

const m = (id: string, group?: string): ModelInfo => ({ id, group, source: "preset" });

describe("modelGrouping", () => {
  it("按 group 分组，未分组落『未分组』", () => {
    const groups = groupModels([m("a", "对话"), m("b"), m("c", "对话")]);
    expect(groups.map(([name]) => name)).toEqual(["对话", "未分组"]);
    expect(groups[0]![1]).toHaveLength(2);
  });
  it("能力筛选", () => {
    const all = [m("a"), { ...m("b"), vision: true }, { ...m("c"), reasoning: true }];
    expect(all.filter(modelGroupName.tabVision).map((x) => x.id)).toEqual(["b"]);
  });
});
