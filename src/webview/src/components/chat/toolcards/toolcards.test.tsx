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
  it.each(["Bash", "Edit", "Read", "Write", "Glob", "Grep", "Task"])(
    "%s 有专属卡（非兜底）",
    (name) => {
      // 兜底卡永远存在，toBeDefined 无法区分映射与兜底——断言不等于兜底才证明 REGISTRY 命中
      expect(getToolCard(name)).not.toBe(getToolCard("Whatever"));
    },
  );
  it("mcp__ 前缀与未知工具走兜底卡", () => {
    expect(getToolCard("mcp__x__y")).toBeDefined();
    expect(getToolCard("Whatever")).toBeDefined();
    expect(getToolCard("mcp__x__y")).toBe(getToolCard("Whatever"));
  });
  it("Bash 卡展示命令与输出", () => {
    const Card = getToolCard("Bash")!;
    render(<Card call={call("Bash", { command: "npm test" })} result={res("9 passed")} open onToggle={() => {}} />);
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText(/9 passed/)).toBeTruthy();
  });
  it("运行中的工具卡带左→右扫光（tool-sweep），完成态没有", () => {
    const Card = getToolCard("Bash")!;
    const { container: running } = render(
      <Card call={call("Bash", { command: "npm test" })} open onToggle={() => {}} />,
    );
    expect(running.querySelector(".tool-sweep")).toBeTruthy();
    const { container: done } = render(
      <Card call={call("Bash", { command: "npm test" })} result={res("ok")} open onToggle={() => {}} />,
    );
    expect(done.querySelector(".tool-sweep")).toBeNull();
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
  it("File 卡展示工具名与目标并展开输出", () => {
    const Card = getToolCard("Read")!;
    render(<Card call={call("Read", { path: "src/app.ts" })} result={res("1\thello")} open onToggle={() => {}} />);
    expect(screen.getByText(/Read src\/app\.ts/)).toBeTruthy();
    expect(screen.getByText(/hello/)).toBeTruthy();
  });
  it("Task 卡展示任务摘要与 agentType 徽标", () => {
    const Card = getToolCard("Task")!;
    render(
      <Card
        call={call("Task", { agentType: "general", description: "调研构建链", prompt: "自包含任务" })}
        result={res("done")} open onToggle={() => {}}
      />,
    );
    expect(screen.getByText("调研构建链")).toBeTruthy();
    expect(screen.getByText("general")).toBeTruthy();
    expect(screen.getByText(/done/)).toBeTruthy();
  });
});
