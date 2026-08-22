// @vitest-environment jsdom
// 槽位环境接线：解析与渲染均包 <SlotProvider> + <BuiltinToolcards />（getToolCard 为渲染期钩子）。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ComponentType } from "react";
import { SlotProvider } from "../../../slots/react";
import type { ToolCallPart, ToolResultPart } from "../../../../../shared/ipc";
import { BuiltinToolcards } from "./builtinToolcards";
import { McpToolCard } from "./McpToolCard";
import { getToolCard, type ToolCardProps } from "./registry";

afterEach(cleanup);

const call = (toolName: string, args: Record<string, unknown>): ToolCallPart =>
  ({ type: "toolCall", id: "a", toolName, args });
const res = (content: string): ToolResultPart =>
  ({ type: "toolResult", toolCallId: "a", content, isError: false, durationMs: 50 });

/** 渲染期探针：在 Provider 内按名解析卡并渲染（探针自身每次渲染捕获一次）。 */
function CardProbe({ name, ...card }: { name: string } & ToolCardProps): React.JSX.Element {
  const Card = getToolCard(name);
  return <Card {...card} />;
}

/** 同步捕获解析结果（render 同步执行，渲染期回调即得引用）。 */
function resolveCard(name: string): ComponentType<ToolCardProps> {
  let resolved: ComponentType<ToolCardProps> | undefined;
  function Capture(): React.JSX.Element | null {
    resolved = getToolCard(name);
    return null;
  }
  render(
    <SlotProvider>
      <BuiltinToolcards />
      <Capture />
    </SlotProvider>,
  );
  return resolved!;
}

/** 标准渲染助手：Provider + 内置注册 + 单卡探针。 */
function renderCard(name: string, card: ToolCardProps): ReturnType<typeof render> {
  return render(
    <SlotProvider>
      <BuiltinToolcards />
      <CardProbe name={name} {...card} />
    </SlotProvider>,
  );
}

describe("tool cards registry", () => {
  it.each(["Bash", "Edit", "Read", "Write", "Glob", "Grep", "Task", "TodoWrite"])(
    "%s 有专属卡（非兜底）",
    (name) => {
      // 兜底卡永远存在，toBeDefined 无法区分映射与兜底——断言不等于兜底才证明槽位命中
      expect(resolveCard(name)).not.toBe(resolveCard("Whatever"));
    },
  );
  it("mcp__ 前缀命中通用 MCP 卡，未知工具走兜底卡", () => {
    expect(resolveCard("mcp__demo_server__fetch_issue")).toBe(McpToolCard);
    expect(resolveCard("mcp__demo_server__fetch_issue")).not.toBe(resolveCard("Whatever"));
    expect(resolveCard("Whatever")).toBeDefined();
  });
  it("Bash 卡展示命令与输出", () => {
    renderCard("Bash", { call: call("Bash", { command: "npm test" }), result: res("9 passed"), open: true, onToggle: () => {} });
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText(/9 passed/)).toBeTruthy();
  });
  it("运行中的工具卡带左→右扫光（tool-sweep），完成态没有", () => {
    const { container: running } = renderCard("Bash", { call: call("Bash", { command: "npm test" }), open: true, onToggle: () => {} });
    expect(running.querySelector(".tool-sweep")).toBeTruthy();
    const { container: done } = renderCard("Bash", { call: call("Bash", { command: "npm test" }), result: res("ok"), open: true, onToggle: () => {} });
    expect(done.querySelector(".tool-sweep")).toBeNull();
  });
  it("Edit 卡渲染 +/- diff 行", () => {
    renderCard("Edit", {
      call: call("Edit", { file_path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;\nconst b = 3;" }),
      result: res("ok"), open: true, onToggle: () => {},
    });
    expect(screen.getByText(/const a = 1;/)).toBeTruthy();
    expect(screen.getByText(/const b = 3;/)).toBeTruthy();
  });
  it("File 卡展示工具名与目标并展开输出", () => {
    renderCard("Read", { call: call("Read", { path: "src/app.ts" }), result: res("1\thello"), open: true, onToggle: () => {} });
    expect(screen.getByText(/Read src\/app\.ts/)).toBeTruthy();
    expect(screen.getByText(/hello/)).toBeTruthy();
  });
  it("Task 卡展示任务摘要与 agentType 徽标", () => {
    renderCard("Task", {
      call: call("Task", { agentType: "general", description: "调研构建链", prompt: "自包含任务" }),
      result: res("done"), open: true, onToggle: () => {},
    });
    expect(screen.getByText("调研构建链")).toBeTruthy();
    expect(screen.getByText("general")).toBeTruthy();
    expect(screen.getByText(/done/)).toBeTruthy();
  });
  it("TodoWrite 卡渲染三状态图标、优先级与计数摘要", () => {
    const { container } = renderCard("TodoWrite", {
      call: call("TodoWrite", { todos: [
        { content: "高优先待办", status: "pending", priority: "high" },
        { content: "进行中任务", status: "in_progress", priority: "medium" },
        { content: "低优先已完成", status: "completed", priority: "low" },
      ] }),
      result: res("3 项：1 进行中 / 1 待办"), open: true, onToggle: () => {},
    });
    // 三种状态图标各有其位（data-status 便于稳定断言，避免与结果 ✓ 撞文本）
    expect(container.querySelector('[data-status="pending"]')?.textContent).toBe("○");
    expect(container.querySelector('[data-status="in_progress"]')?.textContent).toBe("◐");
    expect(container.querySelector('[data-status="completed"]')?.textContent).toBe("✓");
    // 优先级三档均渲染（data-priority 驱动配色钩子）
    expect(container.querySelector('[data-priority="high"]')).toBeTruthy();
    expect(container.querySelector('[data-priority="medium"]')).toBeTruthy();
    expect(container.querySelector('[data-priority="low"]')).toBeTruthy();
    // 计数摘要与任务文本
    expect(screen.getByText(/3 项/)).toBeTruthy();
    expect(screen.getByText(/1 进行中/)).toBeTruthy();
    expect(screen.getByText("高优先待办")).toBeTruthy();
    expect(screen.getByText("低优先已完成")).toBeTruthy();
    // 展开清单可滚动（对齐 FileTool/TaskTool 惯例）+ 条目两行截断 + 结果标记右对齐
    const listClass = container.querySelector("ul")?.className ?? "";
    expect(listClass).toContain("scrollbar-thin");
    expect(listClass).toContain("max-h-48");
    expect(listClass).toContain("overflow-auto");
    expect(screen.getByText("高优先待办").className).toContain("line-clamp-2");
    expect(container.querySelector("button > span.ml-auto")?.textContent).toBe("✓");
  });
  it("TodoWrite 卡空清单显示清空态", () => {
    renderCard("TodoWrite", { call: call("TodoWrite", { todos: [] }), result: res("0 项"), open: true, onToggle: () => {} });
    expect(screen.getByText(/清单已清空/)).toBeTruthy();
  });
});

describe("mcp 通用卡", () => {
  const mcpName = "mcp__demo_server__fetch_issue";
  const mcpResult: ToolResultPart = { type: "toolResult", toolCallId: "a", content: '{"items":[]}', isError: false, durationMs: 1500 };

  it("服务器名与工具名两段展示 + args JSON 折叠 + 结果/耗时", () => {
    renderCard(mcpName, {
      call: call(mcpName, { owner: "acme", repo: "app" }),
      result: mcpResult, open: true, onToggle: () => {},
    });
    expect(screen.getByText("demo_server")).toBeTruthy();
    expect(screen.getByText("fetch_issue")).toBeTruthy();
    // 参数折叠为 JSON 块（对齐兜底卡风格）
    expect(screen.getByText(/"owner": "acme"/)).toBeTruthy();
    expect(screen.getByText(/"repo": "app"/)).toBeTruthy();
    // 结果内容与耗时（1500ms → 1.5s）
    expect(screen.getByText(/\{"items":\[\]\}/)).toBeTruthy();
    expect(screen.getByText(/1\.5s/)).toBeTruthy();
  });
  it("运行中带扫光，完成态无扫光；错误结果标 ✕", () => {
    const { container: running } = renderCard(mcpName, { call: call(mcpName, { q: "x" }), open: true, onToggle: () => {} });
    expect(running.querySelector(".tool-sweep")).toBeTruthy();
    const { container: done } = renderCard(mcpName, { call: call(mcpName, { q: "x" }), result: mcpResult, open: true, onToggle: () => {} });
    expect(done.querySelector(".tool-sweep")).toBeNull();
    const { container: failed } = renderCard(mcpName, {
      call: call(mcpName, { q: "x" }),
      result: { ...mcpResult, isError: true }, open: true, onToggle: () => {},
    });
    expect(failed.querySelector(".tool-sweep")).toBeNull();
    expect(screen.getByText("✕")).toBeTruthy();
  });
  it("折叠态（open=false）不展示参数与结果", () => {
    const { container } = renderCard(mcpName, {
      call: call(mcpName, { owner: "acme" }), result: mcpResult, open: false, onToggle: () => {},
    });
    expect(container.textContent).not.toContain('"owner"');
    expect(container.textContent).not.toContain('"items"');
  });
  it("缺工具段的名字不崩溃（仅服务器段展示）", () => {
    renderCard("mcp__solo", { call: call("mcp__solo", {}), open: true, onToggle: () => {} });
    expect(screen.getByText("solo")).toBeTruthy();
  });
});
