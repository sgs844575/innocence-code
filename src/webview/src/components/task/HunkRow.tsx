// HunkRow — ReviewPanel 的单个 hunk 行（Task 10）。
// 冲突 hunk 永不渲染为已接受：接受按钮禁用并显示「冲突」状态。
// 行体可点选（onSelect → 注入 Composer 请求）；接受/还原按钮阻止冒泡。
import { Check, RotateCcw } from "lucide-react";
import { zhCN } from "../../lib/i18n";
import { countLines, type TaskHunk } from "./taskViewModel";

// t prop 未注入时的兜底：直接查 zhCN 表（同 CodeBlock/MarkdownView 约定）。
const tZh = (key: string): string => zhCN[key] ?? key;

export interface HunkRowProps {
  hunk: TaskHunk;
  t?: (key: string) => string;
  /** 接受：只发 ledger command（TaskReviewDto status=accepted）。 */
  onAccept?: (hunkRef: string) => void;
  /** 还原：发携带 expectedVersion 的 TaskRestoreRequest。 */
  onRestore?: (hunkRef: string) => void;
  /** 点选 hunk → 注入 Composer 请求（ChatView 接线；缺省 no-op）。 */
  onSelect?: (hunkRef: string) => void;
}

const statusKey: Record<TaskHunk["status"], string> = {
  accepted: "task.review.accepted",
  pending: "task.review.pending",
  restored: "task.review.restored",
  conflict: "task.review.conflict",
};

const statusClass: Record<TaskHunk["status"], string> = {
  accepted: "bg-(--color-app-accent)/15 text-(--color-app-accent)",
  pending: "bg-(--color-app-bubble) text-(--color-app-muted)",
  restored: "bg-(--color-app-bubble) text-(--color-app-muted)",
  conflict: "bg-red-600/15 text-red-600",
};

export function HunkRow({ hunk, t = tZh, onAccept, onRestore, onSelect }: HunkRowProps): React.JSX.Element {
  const added = countLines(hunk.after);
  const removed = countLines(hunk.before);
  const conflicted = hunk.status === "conflict";

  const lines = (text: string, mark: "+" | "−", tone: string) =>
    text
      .replace(/\n+$/, "")
      .split("\n")
      .filter((line, index, all) => line !== "" || index < all.length - 1)
      .map((line, i) => (
        <div key={`${mark}${i}`} className={`px-2 font-mono text-[11.5px] leading-5 ${tone}`}>
          {mark} {line || " "}
        </div>
      ));

  return (
    <div
      role="listitem"
      onClick={() => onSelect?.(hunk.ref)}
      className="rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg) hover:border-(--color-app-border)"
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${statusClass[hunk.status]}`}>
          {t(statusKey[hunk.status])}
        </span>
        <span className="font-mono text-[11px] text-emerald-600">+{added}</span>
        <span className="font-mono text-[11px] text-red-600">−{removed}</span>
        <div className="ml-auto flex items-center gap-1">
          {hunk.status === "accepted" && (
            <button
              type="button"
              disabled={!onRestore}
              onClick={(event) => {
                event.stopPropagation();
                onRestore?.(hunk.ref);
              }}
              className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-(--color-app-muted) hover:bg-(--color-app-bubble) disabled:opacity-50"
            >
              <RotateCcw size={12} /> {t("task.review.restore")}
            </button>
          )}
          <button
            type="button"
            disabled={conflicted || hunk.status === "accepted" || !onAccept}
            onClick={(event) => {
              event.stopPropagation();
              onAccept?.(hunk.ref);
            }}
            className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-(--color-app-muted) hover:bg-(--color-app-bubble) disabled:opacity-50"
          >
            <Check size={12} /> {t("task.review.accept")}
          </button>
        </div>
      </div>
      <div className="border-t border-(--color-app-hairline) py-1">
        {lines(hunk.before, "−", "text-red-600/90")}
        {lines(hunk.after, "+", "text-emerald-600/90")}
      </div>
    </div>
  );
}
