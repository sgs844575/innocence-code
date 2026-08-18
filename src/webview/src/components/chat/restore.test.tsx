// @vitest-environment jsdom
// 复现"点击历史会话后消息不加载"：用 hydrate 真实输出形状（text/toolCall/
// toolResult 混排 + thinking）驱动 ChatView 全链路渲染。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../../../shared/ipc";
import { ChatView } from "../ChatView";

afterEach(cleanup);

// jsdom 没有 scrollIntoView
Element.prototype.scrollIntoView = () => {};

const t = (key: string) => key;

/** 与 sessions.ts hydrate 对真实 transcript 的输出一致：
 *  toolResult 已并入 assistant 消息（live 形状）。 */
const restored: ChatMessage[] = [
  { id: "msg_restored_0", role: "user", createdAt: 1, parts: [{ type: "text", text: "帮我跑下测试" }] },
  {
    id: "msg_restored_1",
    role: "assistant",
    createdAt: 1,
    parts: [
      { type: "text", text: "好的，执行：\n\n```bash\nnpm test\n```\n\n" },
      { type: "toolCall", id: "call_a1", toolName: "Bash", args: { command: "npm test" } },
      { type: "toolResult", toolCallId: "call_a1", content: "9 passed", isError: false },
      { type: "text", text: "全部通过。" },
    ],
  },
  { id: "msg_restored_2", role: "user", createdAt: 2, parts: [{ type: "text", text: "再看看文件" }] },
  {
    id: "msg_restored_3",
    role: "assistant",
    createdAt: 2,
    parts: [
      { type: "thinking", text: "先读文件确认结构" },
      { type: "toolCall", id: "call_b2", toolName: "Read", args: { path: "a.ts" } },
      { type: "toolResult", toolCallId: "call_b2", content: "1 hello", isError: false },
    ],
  },
];

// Composer 依赖 settings/api（pickWorkspace 等），mock 掉子组件边界
vi.mock("../Composer", () => ({
  Composer: () => <div data-testid="composer" />,
}));

describe("历史会话恢复渲染（ChatView 全链路）", () => {
  it("用户气泡/正文/折叠组/思考块全部渲染，无崩溃", () => {
    render(
      <ChatView
        t={t}
        appName="InnocenceCode"
        messages={restored}
        streaming={false}
        settings={null}
        permission={null}
        onSettingsChange={() => {}}
        onPermissionRespond={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        landing={false}
        pendingProject=""
        onPickProject={() => {}}
        recentProjects={[]}
        onOpenProjectDir={() => {}}
      />,
    );
    expect(screen.getByText("帮我跑下测试")).toBeTruthy();
    expect(screen.getByText("全部通过。")).toBeTruthy();
    expect(screen.getByText("再看看文件")).toBeTruthy();
    // 两条 assistant 各有一个折叠组
    expect(screen.getAllByText(/chat.turn.operations/)).toHaveLength(2);
    // thinking 折叠行
    expect(screen.getAllByText(/chat.thinking.done/)).toHaveLength(1);
  });
});
