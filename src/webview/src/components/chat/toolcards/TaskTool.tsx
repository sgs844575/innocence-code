import { ChevronRight, Bot } from "lucide-react";
import type { ToolCardProps } from "./registry";

/** Task 卡：子代理任务摘要 + agentType 徽标，open 时展开子代理报告。 */
export function TaskTool({ call, result, open, onToggle }: ToolCardProps): React.JSX.Element {
  const desc = typeof call.args.description === "string" ? call.args.description : "";
  const agentType = typeof call.args.agentType === "string" ? call.args.agentType : "explore";
  return (
    <div className="my-1 overflow-hidden rounded-[10px] border border-(--color-app-hairline) bg-(--color-app-panel)">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-(--color-app-muted) hover:bg-(--color-app-bubble)/40">
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <Bot size={12} className="shrink-0 text-(--color-app-accent)" />
        <span className="truncate text-(--color-app-text)">{desc || "子代理任务"}</span>
        <span className="ml-auto shrink-0 rounded-full border border-(--color-app-hairline) px-1.5 font-mono text-[9.5px]">{agentType}</span>
        <span className={`shrink-0 text-[10px] ${result?.isError ? "text-(--color-tool-err)" : "text-(--color-tool-ok)"}`}>
          {result ? (result.isError ? "✕" : "✓") : "…"}
        </span>
      </button>
      {open && result && (
        <pre className="scrollbar-thin max-h-48 overflow-auto border-t border-(--color-app-hairline) px-2.5 py-2 font-mono text-[11px] leading-relaxed text-(--color-app-muted)">{result.content}</pre>
      )}
    </div>
  );
}
