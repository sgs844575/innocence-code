// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPicker } from "./AgentPicker";
import type { AgentId } from "../../../../shared/ipc";

afterEach(cleanup);

const t = (key: string) => {
  const dict: Record<string, string> = {
    "agent.select": "智能体",
    "agent.default": "默认",
    "agent.plan": "计划",
    "agent.full": "全量",
  };
  return dict[key] ?? key;
};

describe("AgentPicker", () => {
  it("打开后渲染三个内置 agent，选择回调带 id", () => {
    const onChange = vi.fn<(agent: AgentId) => void>();
    render(<AgentPicker t={t} value="default" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "智能体" }));
    for (const label of ["默认", "计划", "全量"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "计划" }));
    expect(onChange).toHaveBeenCalledWith("plan");
  });
  it("当前 agent 名显示在触发 chip 上", () => {
    render(<AgentPicker t={t} value="full" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "智能体" }).textContent).toContain("全量");
  });
});
