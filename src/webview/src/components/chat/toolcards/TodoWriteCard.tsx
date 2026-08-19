import { ChevronRight, ListChecks } from "lucide-react";
import { RunningMark } from "./RunningMark";
import type { ToolCardProps } from "./registry";

/** TodoWrite 卡：会话任务清单 —— 状态图标（○/◐/✓）+ 优先级配色 + 计数摘要。 */
const STATUS_ICON: Record<string, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
};

/** 优先级配色：high=红 / medium=黄 / low=灰（未知值回落灰）。 */
const PRIORITY_CLASS: Record<string, string> = {
  high: "text-(--color-tool-err)",
  medium: "text-(--color-tool-warn)",
  low: "text-(--color-app-muted)",
};

interface TodoItemView {
  content: string;
  status: string;
  priority: string;
}

/** 从持久化 args 里宽松读取清单（坏条目跳过，卡片永不因数据形状崩溃）。 */
function readTodos(args: Record<string, unknown>): TodoItemView[] {
  const todos = args.todos;
  if (!Array.isArray(todos)) return [];
  return todos.filter(
    (t): t is TodoItemView =>
      typeof t === "object" &&
      t !== null &&
      typeof (t as TodoItemView).content === "string" &&
      typeof (t as TodoItemView).status === "string" &&
      typeof (t as TodoItemView).priority === "string",
  );
}

export function TodoWriteCard({ call, result, open, onToggle }: ToolCardProps): React.JSX.Element {
  const todos = readTodos(call.args);
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  const pending = todos.filter((t) => t.status === "pending").length;
  const summary =
    todos.length === 0 ? "清单已清空" : `${todos.length} 项：${inProgress} 进行中 / ${pending} 待办`;
  return (
    <div className={`my-1 overflow-hidden rounded-[10px] border border-(--color-app-hairline) bg-(--color-app-panel) ${result ? "" : "tool-sweep"}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-(--color-app-muted) hover:bg-(--color-app-bubble)/40">
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <ListChecks size={12} className="shrink-0 text-(--color-app-accent)" />
        <span className="shrink-0 text-(--color-app-text)">待办清单</span>
        <span className="truncate">{summary}</span>
        <span className={`shrink-0 text-[10px] ${result?.isError ? "text-(--color-tool-err)" : "text-(--color-tool-ok)"}`}>
          {result ? (result.isError ? "✕" : "✓") : <RunningMark />}
        </span>
      </button>
      {open && (todos.length > 0 || result) && (
        <ul className="border-t border-(--color-app-hairline) px-3 py-2 text-[11px] leading-relaxed">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-1.5 py-0.5">
              <span
                data-status={t.status}
                data-priority={t.priority}
                className={`shrink-0 font-mono ${PRIORITY_CLASS[t.priority] ?? PRIORITY_CLASS.low}`}
              >
                {STATUS_ICON[t.status] ?? "○"}
              </span>
              <span className={`text-(--color-app-text) ${t.status === "completed" ? "line-through opacity-60" : ""}`}>
                {t.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
