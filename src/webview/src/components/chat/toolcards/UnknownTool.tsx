import { ChevronRight, Puzzle } from "lucide-react";
import { RunningMark } from "./RunningMark";
import type { ToolCardProps } from "./registry";

/** 兜底卡：mcp__* 与未来工具统一走这里——工具名 + args JSON + 结果。 */
export function UnknownTool({ call, result, open, onToggle }: ToolCardProps): React.JSX.Element {
  return (
    <div className={`my-1 overflow-hidden rounded-[10px] border border-(--color-app-hairline) bg-(--color-app-panel) ${result ? "" : "tool-sweep"}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[11px] text-(--color-app-muted) hover:bg-(--color-app-bubble)/40">
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <Puzzle size={12} className="shrink-0" />
        <span className="truncate">{call.toolName}</span>
        <span className={`ml-auto shrink-0 text-[10px] ${result?.isError ? "text-(--color-tool-err)" : "text-(--color-tool-ok)"}`}>
          {result ? (result.isError ? "✕" : "✓") : <RunningMark />}
        </span>
      </button>
      {open && (
        <div className="border-t border-(--color-app-hairline) px-2.5 py-2 font-mono text-[11px] leading-relaxed text-(--color-app-muted)">
          <pre className="overflow-x-auto">{JSON.stringify(call.args, null, 2)}</pre>
          {result && <pre className="scrollbar-thin mt-1 max-h-48 overflow-auto">{result.content}</pre>}
        </div>
      )}
    </div>
  );
}
