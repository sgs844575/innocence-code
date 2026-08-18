import { ChevronRight, FileSearch, FileText } from "lucide-react";
import { RunningMark } from "./RunningMark";
import type { ToolCardProps } from "./registry";

const PATH_KEYS = ["file_path", "path", "pattern"] as const;

/** 文件行卡：Read/Write/Glob/Grep 共用，按参数猜出目标路径或模式。 */
export function FileTool({ call, result, open, onToggle }: ToolCardProps): React.JSX.Element {
  const key = PATH_KEYS.find((k) => typeof call.args[k] === "string") ?? PATH_KEYS[0];
  const target = String(call.args[key] ?? "");
  const Icon = call.toolName === "Read" || call.toolName === "Write" ? FileText : FileSearch;
  return (
    <div className={`my-1 overflow-hidden rounded-[10px] border border-(--color-app-hairline) bg-(--color-app-panel) ${result ? "" : "tool-sweep"}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[11px] text-(--color-app-muted) hover:bg-(--color-app-bubble)/40">
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <Icon size={12} className="shrink-0" />
        <span className="truncate">{call.toolName} {target}</span>
        <span className={`ml-auto shrink-0 text-[10px] ${result?.isError ? "text-(--color-tool-err)" : "text-(--color-tool-ok)"}`}>
          {result ? (result.isError ? "✕" : "✓") : <RunningMark />}
        </span>
      </button>
      {open && result && (
        <pre className="scrollbar-thin max-h-48 overflow-auto border-t border-(--color-app-hairline) px-2.5 py-2 font-mono text-[11px] leading-relaxed text-(--color-app-muted)">{result.content}</pre>
      )}
    </div>
  );
}
