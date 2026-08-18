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

/** 任务完成后的归并视图：一轮内所有工具段合成一个组（首个工具段的位置），
 *  纯空白 text 段丢弃；有意义的 text 段保持原顺序。流式期间不用——
 *  逐段展开更贴近执行过程，完成后合并成一行组记录（用户偏好）。 */
export function coalesceToolSegments(segments: Segment[]): Segment[] {
  const toolsParts = segments.flatMap((s) => (s.kind === "tools" ? s.parts : []));
  if (toolsParts.length === 0) return segments;
  let placed = false;
  const out: Segment[] = [];
  for (const seg of segments) {
    if (seg.kind === "tools") {
      if (!placed) {
        out.push({ kind: "tools", parts: toolsParts });
        placed = true;
      }
    } else if (seg.kind === "text" && seg.text.trim() === "") {
      // 空 text 段（轮间 "\n\n" 等）不产出空段落
    } else {
      out.push(seg);
    }
  }
  return out;
}
