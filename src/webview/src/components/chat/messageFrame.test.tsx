// @vitest-environment jsdom
// MessageFrame 对 ThinkingBlock 的 live 判定：思考结束后（消息仍在流式、
// 末段已是正文/工具）必须收成静态"已思考"，shimmer 不许残留。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MessagePart } from "../../../../shared/ipc";
import { MessageFrame } from "./MessageFrame";

afterEach(cleanup);
Element.prototype.scrollIntoView = () => {};

const t = (key: string) => key;
const onQuote = () => {};

describe("MessageFrame 思考块的 live 判定", () => {
  it("思考是末段且流式中 → live（shimmer 预览）", () => {
    const { container } = render(
      <MessageFrame
        parts={[{ type: "thinking", text: "正在推理……" }] as MessagePart[]}
        streaming
        isLatest
        t={t}
        onQuote={onQuote}
      />,
    );
    // live 分支：shimmer 预览行（文本尾段 + .shimmer 类），无"已思考"静态行
    expect(screen.getByText(/正在推理/)).toBeTruthy();
    expect(container.querySelector(".shimmer")).toBeTruthy();
    expect(screen.queryByText(/chat.thinking.done/)).toBeNull();
  });
  it("思考已结束（末段是正文）即使消息仍在流式 → 静态'已思考'，shimmer 消失", () => {
    render(
      <MessageFrame
        parts={[
          { type: "thinking", text: "推理完成内容" },
          { type: "text", text: "答案是 42。" },
        ] as MessagePart[]}
        streaming
        isLatest
        t={t}
        onQuote={onQuote}
      />,
    );
    expect(screen.queryByText(/chat.thinking.live/)).toBeNull();
    expect(screen.getByText(/chat.thinking.done/)).toBeTruthy();
  });
});
