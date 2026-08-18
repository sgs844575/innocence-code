import type { MessagePart, ToolCallPart, ToolResultPart } from "../../../../shared/ipc";

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tools"; parts: (ToolCallPart | ToolResultPart)[] };

/** 把扁平 parts 切成渲染段：text 合并、thinking 独立、工具连续成块。 */
export function segmentParts(parts: MessagePart[]): Segment[] {
  const out: Segment[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (part.type === "text") {
      if (last?.kind === "text") last.text += part.text;
      else out.push({ kind: "text", text: part.text });
    } else if (part.type === "thinking") {
      if (last?.kind === "thinking") last.text += part.text;
      else out.push({ kind: "thinking", text: part.text });
    } else {
      if (last?.kind === "tools") last.parts.push(part);
      else out.push({ kind: "tools", parts: [part] });
    }
  }
  return out;
}

/** 任务完成后的归并视图：把仅被空白 text 段（工具轮间的 "\n\n"）分隔的
 *  工具段合成一个组，空白段丢弃。**不做任何重排**——正文一旦出现就是
 *  时间线屏障，其前后的工具组保持原位：合并只发生在"连续工具活动"内部，
 *  回顾时内容顺序与执行顺序严格一致。流式期间不用（逐段展开更贴近过程）。 */
export function coalesceToolSegments(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (seg.kind === "tools") {
      if (last?.kind === "tools") last.parts.push(...seg.parts);
      else out.push({ kind: "tools", parts: [...seg.parts] });
    } else if (seg.kind === "text" && seg.text.trim() === "") {
      // 空白 text 段不产出空段落，也不是时间线内容
    } else {
      out.push(seg);
    }
  }
  return out;
}
