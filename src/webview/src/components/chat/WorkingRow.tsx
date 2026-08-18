import { BrainCircuit, Loader2, Terminal } from "lucide-react";
import type { MessagePart } from "../../../../shared/ipc";

export type WorkingState =
  | { kind: "idle" }
  | { kind: "start" }
  | { kind: "thinking" }
  | { kind: "tool"; toolName: string };

/** 从消息 parts 推断当前活动状态（真空档检测）：存在未完成的 toolCall
 *  → 工具执行中；末尾是 thinking → 思考中；末段是 text → 正在出字
 *  （stream-caret 已覆盖，无需此行）；其余（空 parts / 工具间过渡）→ 进行中。 */
export function workingStateOf(parts: MessagePart[]): WorkingState {
  if (parts.length === 0) return { kind: "start" };
  const pending = new Set<string>();
  let lastPending = "";
  for (const p of parts) {
    if (p.type === "toolCall") {
      pending.add(p.id);
      lastPending = p.toolName;
    } else if (p.type === "toolResult") {
      pending.delete(p.toolCallId);
    }
  }
  if (pending.size > 0) return { kind: "tool", toolName: lastPending };
  const last = parts[parts.length - 1]!;
  if (last.type === "thinking") return { kind: "thinking" };
  if (last.type === "text") return { kind: "idle" };
  return { kind: "start" }; // 末尾是 toolResult：两个工具之间 / 即将收尾
}

/** 消息底部的活动指示行：旋转图标 + 当前动作标签，只在无文字流出的
 *  真空档渲染（文本流出时由 stream-caret 接管）。 */
export function WorkingRow({ state, t }: { state: WorkingState; t: (key: string) => string }): React.JSX.Element | null {
  if (state.kind === "idle") return null;
  if (state.kind === "thinking") {
    return (
      <div className="flex items-center gap-2 py-1 text-[11.5px] text-(--color-app-muted)">
        <BrainCircuit size={13} className="animate-pulse text-(--color-app-accent)" />
        {t("chat.working.thinking")}
      </div>
    );
  }
  if (state.kind === "tool") {
    return (
      <div className="tool-sweep flex items-center gap-2 rounded-lg py-1 text-[11.5px] text-(--color-app-muted)">
        <Terminal size={13} className="text-(--color-app-accent)" />
        <Loader2 size={12} className="animate-spin text-(--color-app-accent)" />
        {t("chat.working.tool").replace("{tool}", state.toolName)}
      </div>
    );
  }
  return (
    <div className="tool-sweep flex items-center gap-2 rounded-lg py-1 text-[11.5px] text-(--color-app-muted)">
      <Loader2 size={13} className="animate-spin text-(--color-app-accent)" />
      {t("chat.working.start")}
    </div>
  );
}
