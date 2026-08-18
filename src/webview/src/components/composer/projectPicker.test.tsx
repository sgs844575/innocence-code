// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPicker } from "./ProjectPicker";

afterEach(cleanup);

const t = (key: string) => {
  const dict: Record<string, string> = {
    "workspace.pick": "选择项目",
    "project.none": "不在项目中工作",
    "project.open": "打开项目…",
    "project.recent": "近期聊天的项目",
    "project.sessions": "{n} 次会话",
  };
  return dict[key] ?? key;
};
const recent = [
  { path: "D:/Projects/AiProjects/InnocenceCode", count: 3 },
  { path: "D:/Projects/AiProjects/cherry-studio", count: 1 },
];

describe("ProjectPicker（落地态项目选择）", () => {
  it("三段结构：不在项目中 / 打开项目 / 近期项目（含路径与会话数）", async () => {
    const onOpenProject = vi.fn();
    render(<ProjectPicker t={t} value="" recent={recent} onSelect={() => {}} onOpenProject={onOpenProject} />);
    fireEvent.click(screen.getByRole("button", { name: "选择项目" }));
    expect(await screen.findByText("不在项目中工作")).toBeTruthy();
    expect(screen.getByText("打开项目…")).toBeTruthy();
    expect(screen.getByText(/D:.Projects.AiProjects.InnocenceCode/)).toBeTruthy();
    expect(screen.getByText("3 次会话")).toBeTruthy();
    expect(screen.getByText("1 次会话")).toBeTruthy();
  });
  it("选择近期项目回调完整路径；「打开项目…」走目录选择回调", async () => {
    const onSelect = vi.fn();
    const onOpenProject = vi.fn();
    render(<ProjectPicker t={t} value="" recent={recent} onSelect={onSelect} onOpenProject={onOpenProject} />);
    fireEvent.click(screen.getByRole("button", { name: "选择项目" }));
    fireEvent.click(await screen.findByText("cherry-studio"));
    expect(onSelect).toHaveBeenCalledWith("D:/Projects/AiProjects/cherry-studio");
    fireEvent.click(screen.getByRole("button", { name: "打开项目…" }));
    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });
  it("选中项目名显示在触发器上（basename）", () => {
    render(<ProjectPicker t={t} value="D:/x/alpha" recent={[]} onSelect={() => {}} onOpenProject={() => {}} />);
    expect(screen.getByRole("button", { name: "选择项目" }).textContent).toContain("alpha");
  });
});
