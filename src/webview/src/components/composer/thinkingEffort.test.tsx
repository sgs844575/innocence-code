// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingEffortPicker } from "./ThinkingEffortPicker";

afterEach(cleanup);

const t = (key: string) => {
  const dict: Record<string, string> = {
    "reasoning.effort": "思考强度",
    "reasoning.effort.default": "默认",
    "reasoning.effort.off": "关闭",
    "reasoning.effort.low": "低",
    "reasoning.effort.medium": "中",
    "reasoning.effort.high": "高",
  };
  return dict[key] ?? key;
};

describe("ThinkingEffortPicker", () => {
  it("选择档位回调并带对勾标记", () => {
    const onChange = vi.fn();
    render(<ThinkingEffortPicker t={t} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "思考强度" }));
    fireEvent.click(screen.getByRole("button", { name: "高" }));
    expect(onChange).toHaveBeenCalledWith("high");
  });
  it("当前档位显示在触发 chip 上", () => {
    render(<ThinkingEffortPicker t={t} value="medium" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "思考强度" }).textContent).toContain("中");
  });
});
