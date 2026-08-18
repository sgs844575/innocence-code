import { ChevronRight, Terminal } from "lucide-react";
import { RunningMark } from "./RunningMark";
import type { ToolCardProps } from "./registry";

/** Bash 卡：命令一行 + open 时滚动输出，耗时/失败态右对齐。 */
export function BashTool({ call, result, open, onToggle }: ToolCardProps): React.JSX.Element {
  const command = typeof call.args.command === "string" ? call.args.command : JSON.stringify(call.args);
  return (
    <div className="my-1 overflow-hidden rounded-[10px] border border-(--color-app-hairline) bg-(--color-code-bg)">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[11px] text-(--color-code-fg)/80 hover:bg-white/5">
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <Terminal size={12} className="shrink-0" />
        <span className="truncate">{command}</span>
        <span className={`ml-auto shrink-0 text-[10px] ${result?.isError ? "text-(--color-tool-err)" : "text-(--color-tool-ok)"}`}>
          {result
            ? result.isError
              ? "✕"
              : result.durationMs != null
                ? `✓ ${(result.durationMs / 1000).toFixed(1)}s`
                : "✓"
            : <RunningMark />}
        </span>
      </button>
      {open && result && (
        <pre className="scrollbar-thin max-h-56 overflow-auto border-t border-white/10 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-(--color-code-fg)/70">{result.content}</pre>
      )}
    </div>
  );
}
