import { describe, expect, it } from "vitest";
import { pairTools, summarizeTurn } from "./turnSummary";

const call = (id: string, toolName: string) => ({ type: "toolCall" as const, id, toolName, args: {} });
const res = (id: string, ms = 100) => ({ type: "toolResult" as const, toolCallId: id, content: "out", isError: false, durationMs: ms });

describe("turnSummary", () => {
  it("配对 call 与 result", () => {
    const pairs = pairTools([call("a", "Bash"), res("a"), call("b", "Edit"), res("b", 50)]);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toMatchObject({ call: { toolName: "Bash" }, result: { durationMs: 100 } });
  });
  it("无 result 的 call 配 undefined（运行中）", () => {
    const pairs = pairTools([call("a", "Bash")]);
    expect(pairs[0]!.result).toBeUndefined();
  });
  it("组摘要：去重工具名 + 总耗时", () => {
    const s = summarizeTurn([call("a", "Bash"), res("a", 300), call("b", "Bash"), res("b", 200), call("c", "Edit"), res("c", 100)]);
    expect(s.count).toBe(3);
    expect(s.tools).toEqual(["Bash ×2", "Edit"]);
    expect(s.totalMs).toBe(600);
  });
});
