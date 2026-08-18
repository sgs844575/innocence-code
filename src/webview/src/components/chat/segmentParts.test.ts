import { describe, expect, it } from "vitest";
import { coalesceToolSegments, segmentParts } from "./segmentParts";
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

describe("coalesceToolSegments（任务完成后的归并视图）", () => {
  it("仅被空白 text 分隔的工具段合成一个；空 text 段丢弃、顺序不变", () => {
    const call1 = p({ type: "toolCall", id: "t1", toolName: "Read", args: {} });
    const res1 = p({ type: "toolResult", toolCallId: "t1", content: "a", isError: false });
    const call2 = p({ type: "toolCall", id: "t2", toolName: "Bash", args: {} });
    const res2 = p({ type: "toolResult", toolCallId: "t2", content: "b", isError: false });
    const segs = segmentParts([
      p({ type: "text", text: "先看：" }),
      call1, res1,
      p({ type: "text", text: "\n\n" }), // 轮间空白：归并后消失
      call2, res2,
      p({ type: "text", text: "完成" }),
    ]);
    const out = coalesceToolSegments(segs);
    expect(out).toEqual([
      { kind: "text", text: "先看：" },
      { kind: "tools", parts: [call1, res1, call2, res2] },
      { kind: "text", text: "完成" },
    ]);
  });
  it("正文是时间线屏障：夹在工具之间的有意义 text 不被打乱、两侧不合并", () => {
    const call1 = p({ type: "toolCall", id: "t1", toolName: "Read", args: {} });
    const res1 = p({ type: "toolResult", toolCallId: "t1", content: "a", isError: false });
    const call2 = p({ type: "toolCall", id: "t2", toolName: "Bash", args: {} });
    const res2 = p({ type: "toolResult", toolCallId: "t2", content: "b", isError: false });
    const out = coalesceToolSegments(
      segmentParts([call1, res1, p({ type: "text", text: "结构清楚了，接着改：" }), call2, res2]),
    );
    expect(out).toEqual([
      { kind: "tools", parts: [call1, res1] },
      { kind: "text", text: "结构清楚了，接着改：" },
      { kind: "tools", parts: [call2, res2] },
    ]);
  });
  it("无工具段或单一工具段原样返回（含 thinking）", () => {
    const noTools = segmentParts([p({ type: "text", text: "hi" })]);
    expect(coalesceToolSegments(noTools)).toEqual(noTools);
    const one = segmentParts([
      p({ type: "thinking", text: "想" }),
      p({ type: "toolCall", id: "t", toolName: "Read", args: {} }),
    ]);
    expect(coalesceToolSegments(one)).toEqual(one);
  });
});
