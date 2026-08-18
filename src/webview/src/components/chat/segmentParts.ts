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
