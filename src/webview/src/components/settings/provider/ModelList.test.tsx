// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelList } from "./ModelList";
import type { ProviderProfile } from "../../../../../shared/ipc";

afterEach(cleanup);

const profile: ProviderProfile = {
  id: "a", name: "智谱", kind: "openai", apiKey: "", baseURL: "", enabled: true,
  models: [
    { id: "glm-4.6", name: "GLM-4.6", group: "对话", source: "preset", tools: true },
    { id: "glm-4v", name: "GLM-4V", group: "多模态", source: "preset", vision: true },
  ],
};
// listModels 为必填 prop（ProviderDetail 契约）；本组件族当前不直接消费，哑实现即可。
const listModels = vi.fn().mockResolvedValue([]);

describe("ModelList", () => {
  it("按分组渲染折叠卡", () => {
    render(<ModelList profile={profile} onChange={() => {}} listModels={listModels} onPatchModel={() => {}} onToast={() => {}} />);
    expect(screen.getByText("对话")).toBeTruthy();
    expect(screen.getByText("多模态")).toBeTruthy();
    expect(screen.getByText("GLM-4.6")).toBeTruthy();
  });
  it("能力筛选 tab 只留视觉模型", () => {
    render(<ModelList profile={profile} onChange={() => {}} listModels={listModels} onPatchModel={() => {}} onToast={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "👁" }));
    expect(screen.queryByText("GLM-4.6")).toBeNull();
    expect(screen.getByText("GLM-4V")).toBeTruthy();
  });
  it("删除模型回调 onChange", () => {
    const onChange = vi.fn();
    render(<ModelList profile={profile} onChange={onChange} listModels={listModels} onPatchModel={() => {}} onToast={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "删除 glm-4.6" }));
    expect(onChange).toHaveBeenCalledWith({ models: [profile.models[1]] });
  });
  it("过滤零结果提示无匹配，与空态占位区分", () => {
    render(<ModelList profile={profile} onChange={() => {}} listModels={listModels} onPatchModel={() => {}} onToast={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("搜索"), { target: { value: "no-such" } });
    expect(screen.getByText("无匹配模型")).toBeTruthy();
    expect(screen.queryByText(/暂无模型/)).toBeNull();
  });
});
