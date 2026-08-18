// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Popover } from "./Popover";
import { Switch } from "./Switch";
import { CapabilityTags } from "../tags/CapabilityTags";

afterEach(cleanup);

describe("ui 基础件", () => {
  it("Popover 点击触发器打开内容", () => {
    render(
      <Popover trigger={<button>open</button>}>
        <div>panel</div>
      </Popover>,
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(screen.getByText("panel")).toBeTruthy();
  });
  it("Switch 点击切换并回调", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} aria-label="s" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
  it("能力标签按固定顺序渲染", () => {
    render(<CapabilityTags model={{ reasoning: true, tools: true, vision: true, id: "x", source: "manual" }} />);
    const titles = screen.getAllByTestId("cap-tag").map((el) => el.getAttribute("title"));
    expect(titles).toEqual(["视觉", "工具调用", "推理"]);
  });
});
