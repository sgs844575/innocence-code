import { describe, expect, it } from "vitest";
import { filterProviderList } from "./providerFilter";
import type { ProviderProfile } from "../../../../../shared/ipc";

const mk = (over: Partial<ProviderProfile>): ProviderProfile => ({
  id: "x", name: "X", kind: "openai", apiKey: "", baseURL: "", enabled: false, models: [], ...over,
});
const profiles = [
  mk({ id: "a", name: "智谱", enabled: true, models: [{ id: "glm-4.6", source: "preset" }] }),
  mk({ id: "b", name: "DeepSeek", enabled: false }),
];

describe("filterProviderList", () => {
  it("全部/已启用两种模式", () => {
    expect(filterProviderList(profiles, "", "all")).toHaveLength(2);
    expect(filterProviderList(profiles, "", "enabled")).toHaveLength(1);
  });
  it("搜索匹配厂家名与模型 id", () => {
    expect(filterProviderList(profiles, "glm", "all")).toHaveLength(1);
    expect(filterProviderList(profiles, "deep", "all")).toHaveLength(1);
    expect(filterProviderList(profiles, "zzz", "all")).toHaveLength(0);
  });
});
