// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TurnCollapse } from "./TurnCollapse";
import type { ToolCallPart, ToolResultPart } from "../../../../shared/ipc";

afterEach(cleanup);


const call: ToolCallPart = { type: "toolCall", id: "a", toolName: "Bash", args: { command: "ls" } };
const result: ToolResultPart = { type: "toolResult", toolCallId: "a", content: "x", isError: false, durationMs: 50 };
const t = (k: string) => k;

describe("TurnCollapse", () => {
  it("完成态默认折叠，点击组行展开工具行", () => {
    render(<TurnCollapse parts={[call, result]} live={false} t={t} />);
    expect(screen.queryByText("ls")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /1 个操作/ }));
    expect(screen.getByText(/ls/)).toBeTruthy();
  });
  it("流式态默认展开", () => {
    render(<TurnCollapse parts={[call]} live t={t} />);
    expect(screen.getByText(/ls/)).toBeTruthy();
  });
});
