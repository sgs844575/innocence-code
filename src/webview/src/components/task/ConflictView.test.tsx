// @vitest-environment jsdom
// ConflictView 测试（Task 10）：expected/agent/current 三方展示 + 三个显式动作，
// 绝不静默覆盖（无动作回调时不自动解决）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictView } from "./ConflictView";
import { buildConflictTrio, type TaskHunk } from "./taskViewModel";

const hunk: TaskHunk = {
  ref: "t1:0",
  path: "src/a.ts",
  before: "base line\n",
  after: "agent line\n",
  context: [],
  status: "conflict",
};

const trios = [buildConflictTrio(hunk, "current line\n", "外部修改与任务写入重叠")];

afterEach(cleanup);

describe("ConflictView", () => {
  it("renders the expected, agent and current sides with the reason", () => {
    render(
      <ConflictView
        conflicts={trios}
        onKeepCurrent={vi.fn()}
        onAdoptAgent={vi.fn()}
        onAskRedo={vi.fn()}
      />,
    );
    expect(screen.getByText("期望（基线）")).toBeTruthy();
    expect(screen.getByText("Agent 修改")).toBeTruthy();
    expect(screen.getByText("当前工作区")).toBeTruthy();
    expect(screen.getByText("base line")).toBeTruthy();
    expect(screen.getByText("agent line")).toBeTruthy();
    expect(screen.getByText("current line")).toBeTruthy();
    expect(screen.getByText("外部修改与任务写入重叠")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
  });

  it("fires exactly the explicitly chosen action and never auto-resolves", () => {
    const onKeepCurrent = vi.fn();
    const onAdoptAgent = vi.fn();
    const onAskRedo = vi.fn();
    render(
      <ConflictView
        conflicts={trios}
        onKeepCurrent={onKeepCurrent}
        onAdoptAgent={onAdoptAgent}
        onAskRedo={onAskRedo}
      />,
    );
    // 挂载时不触发任何解决动作
    expect(onKeepCurrent).not.toHaveBeenCalled();
    expect(onAdoptAgent).not.toHaveBeenCalled();
    expect(onAskRedo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "保留当前" }));
    expect(onKeepCurrent).toHaveBeenCalledWith("src/a.ts");
    expect(onAdoptAgent).not.toHaveBeenCalled();
    expect(onAskRedo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "采用 Agent" }));
    expect(onAdoptAgent).toHaveBeenCalledWith("src/a.ts");
    expect(onAskRedo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "让 Agent 重做" }));
    expect(onAskRedo).toHaveBeenCalledWith("src/a.ts");
  });

  it("disables every action when no handler is provided (no silent overwrite)", () => {
    render(<ConflictView conflicts={trios} />);
    const keep = screen.getByRole("button", { name: "保留当前" }) as HTMLButtonElement;
    const adopt = screen.getByRole("button", { name: "采用 Agent" }) as HTMLButtonElement;
    const redo = screen.getByRole("button", { name: "让 Agent 重做" }) as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
    expect(adopt.disabled).toBe(true);
    expect(redo.disabled).toBe(true);
  });

  it("builds the trio sides from the hunk and the current workspace content", () => {
    expect(trios[0]).toEqual({
      path: "src/a.ts",
      reason: "外部修改与任务写入重叠",
      expected: "base line\n",
      agent: "agent line\n",
      current: "current line\n",
    });
  });
});
