// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MessagePart } from "../../../../shared/ipc";
import { WorkingRow, workingStateOf } from "./WorkingRow";

afterEach(cleanup);

const t = (key: string) => key;
const call = (id: string, toolName = "Bash"): MessagePart => ({ type: "toolCall", id, toolName, args: {} });
const res = (id: string): MessagePart => ({ type: "toolResult", toolCallId: id, content: "out", isError: false });
const text = (s: string): MessagePart => ({ type: "text", text: s });

describe("workingStateOf 真空档检测", () => {
  it("空 parts → start；未完成 toolCall → tool；思考尾 → thinking；文本尾 → idle", () => {
    expect(workingStateOf([])).toEqual({ kind: "start" });
    expect(workingStateOf([call("a")])).toEqual({ kind: "tool", toolName: "Bash" });
    expect(workingStateOf([text("hi"), call("a"), res("a"), { type: "thinking", text: "…" }])).toEqual({ kind: "thinking" });
    expect(workingStateOf([call("a"), res("a"), text("done")])).toEqual({ kind: "idle" });
    // 两个工具之间（末尾 toolResult）仍是进行中
    expect(workingStateOf([call("a"), res("a")])).toEqual({ kind: "start" });
  });
});

describe("WorkingRow 渲染", () => {
  it("工具执行中显示工具名标签（{tool} 已替换）", () => {
    render(<WorkingRow state={{ kind: "tool", toolName: "Grep" }} t={t} />);
    expect(screen.getByText("chat.working.tool".replace("{tool}", "Grep"))).toBeTruthy();
  });
  it("idle 不渲染任何行", () => {
    const { container } = render(<WorkingRow state={{ kind: "idle" }} t={t} />);
    expect(container.textContent).toBe("");
  });
});
