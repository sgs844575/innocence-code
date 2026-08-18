import { describe, expect, it } from "vitest";
import { segmentParts } from "./segmentParts";
import type { MessagePart } from "../../../../shared/ipc";

const p = (x: MessagePart) => x;

describe("segmentParts", () => {
  it("连续 text 合并，工具段成块，思考独立", () => {
    const parts = [
      p({ type: "thinking", text: "想" }),
      p({ type: "text", text: "a" }),
      p({ type: "text", text: "b" }),
      p({ type: "toolCall", id: "t1", toolName: "Bash", args: {} }),
      p({ type: "toolResult", toolCallId: "t1", content: "out", isError: false }),
      p({ type: "text", text: "done" }),
    ];
    expect(segmentParts(parts)).toEqual([
      { kind: "thinking", text: "想" },
      { kind: "text", text: "ab" },
      { kind: "tools", parts: parts.slice(3, 5) },
      { kind: "text", text: "done" },
    ]);
  });
  it("空数组返回空", () => {
    expect(segmentParts([])).toEqual([]);
  });
});
