// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditModelDrawer } from "./EditModelDrawer";
import type { ModelInfo } from "../../../../../shared/ipc";

afterEach(cleanup);

const model: ModelInfo = { id: "glm-4.6", name: "GLM-4.6", source: "preset", tools: true, contextWindow: 200000, maxOutput: 8192 };

describe("EditModelDrawer", () => {
  it("名称失焦触发保存并标 dirty", () => {
    const onSave = vi.fn();
    render(<EditModelDrawer open model={model} onClose={() => {}} onSave={onSave} />);
    const input = screen.getByDisplayValue("GLM-4.6");
    fireEvent.change(input, { target: { value: "GLM-4.6 改" } });
    fireEvent.blur(input);
    expect(onSave).toHaveBeenCalledWith({ name: "GLM-4.6 改", dirty: true });
  });
  it("能力 pill 开关立即保存", () => {
    const onSave = vi.fn();
    render(<EditModelDrawer open model={model} onClose={() => {}} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "视觉" }));
    expect(onSave).toHaveBeenCalledWith({ vision: true, dirty: true });
  });
  it("上下文三件套失焦保存数字", () => {
    const onSave = vi.fn();
    render(<EditModelDrawer open model={model} onClose={() => {}} onSave={onSave} />);
    const ctx = screen.getByLabelText("上下文窗口");
    fireEvent.change(ctx, { target: { value: "300000" } });
    fireEvent.blur(ctx);
    expect(onSave).toHaveBeenCalledWith({ contextWindow: 300000, dirty: true });
  });
});
