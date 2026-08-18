// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getToolCard } from "./registry";
import type { ToolCallPart, ToolResultPart } from "../../../../../shared/ipc";

afterEach(cleanup);

const call = (toolName: string, args: Record<string, unknown>): ToolCallPart =>
  ({ type: "toolCall", id: "a", toolName, args });
const res = (content: string): ToolResultPart =>
  ({ type: "toolResult", toolCallId: "a", content, isError: false, durationMs: 50 });

describe("tool cards registry", () => {
  it.each(["Bash", "Edit", "Read", "Write", "Glob", "Grep", "Task"])("%s 有专属卡", (name) => {
    expect(getToolCard(name)).toBeDefined();
  });
  it("mcp__ 前缀与未知工具走兜底卡", () => {
    expect(getToolCard("mcp__x__y")).toBeDefined();
    expect(getToolCard("Whatever")).toBeDefined();
  });
  it("Bash 卡展示命令与输出", () => {
    const Card = getToolCard("Bash")!;
    render(<Card call={call("Bash", { command: "npm test" })} result={res("9 passed")} open onToggle={() => {}} />);
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText(/9 passed/)).toBeTruthy();
  });
  it("Edit 卡渲染 +/- diff 行", () => {
    const Card = getToolCard("Edit")!;
    render(
      <Card
        call={call("Edit", { file_path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;\nconst b = 3;" })}
        result={res("ok")} open onToggle={() => {}}
      />,
    );
    expect(screen.getByText(/const a = 1;/)).toBeTruthy();
    expect(screen.getByText(/const b = 3;/)).toBeTruthy();
  });
});
