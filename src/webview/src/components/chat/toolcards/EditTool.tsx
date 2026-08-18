import { ChevronRight, FilePenLine } from "lucide-react";
import type { ToolCardProps } from "./registry";

/** Edit 卡：文件名 + +/- 行数摘要，open 时逐行 diff（红删绿增）。 */
export function EditTool({ call, result, open, onToggle }: ToolCardProps): React.JSX.Element {
  const file =
    typeof call.args.file_path === "string"
      ? call.args.file_path
      : typeof call.args.path === "string"
        ? call.args.path
        : "";
  const oldS = typeof call.args.old_string === "string" ? call.args.old_string : "";
  const newS = typeof call.args.new_string === "string" ? call.args.new_string : "";
  const add = newS.split("\n").length;
  const del = oldS.split("\n").length;
  return (
    <div className={`my-1 overflow-hidden rounded-[10px] border border-(--color-app-hairline) bg-(--color-app-panel) ${result ? "" : "tool-sweep"}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[11px] text-(--color-app-muted) hover:bg-(--color-app-bubble)/40">
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <FilePenLine size={12} className="shrink-0" />
        <span className="truncate">{file}</span>
        <span className="ml-auto shrink-0 text-[10px]">
          <span className="text-(--color-diff-add)">+{add}</span> <span className="text-(--color-diff-del)">−{del}</span>
          {result?.isError && <span className="ml-1 text-(--color-tool-err)">✕</span>}
        </span>
      </button>
      {open && (
        <pre className="scrollbar-thin max-h-56 overflow-auto border-t border-(--color-app-hairline) px-2.5 py-2 font-mono text-[11px] leading-relaxed">
          {oldS.split("\n").map((l, i) => (
            <span key={`d${i}`} className="block bg-(--color-diff-del-bg) px-1.5 text-(--color-diff-del)">− {l}</span>
          ))}
          {newS.split("\n").map((l, i) => (
            <span key={`a${i}`} className="block bg-(--color-diff-add-bg) px-1.5 text-(--color-diff-add)">+ {l}</span>
          ))}
        </pre>
      )}
    </div>
  );
}
