// ReviewPanel — 整批 / 文件 / hunk 三级审查面板（Task 10）。
// accept 只发 ledger command（TaskReviewDto status=accepted，hunkRef=null 表示
// 整批）；restore 发携带 expectedVersion 的 TaskRestoreRequest。无逐行选择；
// 点选 hunk 通过 onHunkSelected 注入 Composer 请求（由 ChatView 接线）。
import { CheckCheck } from "lucide-react";
import type { TaskRestoreRequest, TaskReviewDto } from "../../../../shared/taskIpc";
import { zhCN } from "../../lib/i18n";
import { HunkRow } from "./HunkRow";
import type { FileReviewGroup } from "./taskViewModel";

const tZh = (key: string): string => zhCN[key] ?? key;

export interface ReviewPanelProps {
  /** taskViewModel.groupHunksByFile 的产物（按文件分组）。 */
  files: FileReviewGroup[];
  taskId?: string;
  routeId?: string;
  /** main 下发的不可伪造版本令牌；restore 必带。 */
  expectedVersion?: string;
  t?: (key: string) => string;
  onReview?: (dto: TaskReviewDto) => void;
  onRestore?: (request: TaskRestoreRequest) => void;
  onHunkSelected?: (hunkRef: string) => void;
}

export function ReviewPanel({
  files,
  taskId = "",
  routeId = "",
  expectedVersion = "",
  t = tZh,
  onReview,
  onRestore,
  onHunkSelected,
}: ReviewPanelProps): React.JSX.Element {
  const acceptCommand = (hunkRef: string | null): TaskReviewDto => ({
    taskId,
    routeId,
    hunkRef,
    status: "accepted",
    expectedVersion,
  });

  // 文件级接受：DTO 无文件作用域，逐 hunk 发 ledger command。
  const acceptFile = (group: FileReviewGroup) => {
    for (const hunk of group.hunks) onReview?.(acceptCommand(hunk.ref));
  };

  return (
    <section
      aria-label={t("task.review.title")}
      className="rounded-xl border border-(--color-app-hairline) bg-(--color-app-panel)"
    >
      <header className="flex items-center gap-2 border-b border-(--color-app-hairline) px-3 py-2">
        <span className="text-[12.5px] font-semibold">{t("task.review.title")}</span>
        <button
          type="button"
          disabled={!onReview || files.length === 0}
          onClick={() => onReview?.(acceptCommand(null))}
          className="ml-auto flex h-7 items-center gap-1.5 rounded bg-(--color-app-accent) px-2.5 text-[12px] font-medium text-(--color-app-accent-fg) disabled:opacity-50"
        >
          <CheckCheck size={13} /> {t("task.review.acceptAll")}
        </button>
      </header>
      <div className="space-y-3 px-3 py-3">
        {files.map((group) => (
          <div key={group.path} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 truncate font-mono text-[12px]" title={group.path}>
                {group.path}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-emerald-600">+{group.added}</span>
              <span className="shrink-0 font-mono text-[11px] text-red-600">−{group.removed}</span>
              <button
                type="button"
                disabled={!onReview}
                onClick={() => acceptFile(group)}
                className="ml-auto h-6 shrink-0 rounded border border-(--color-app-border) px-2 text-[11px] text-(--color-app-muted) hover:bg-(--color-app-bubble) disabled:opacity-50"
              >
                {t("task.review.acceptFile")}
              </button>
            </div>
            <div role="list" className="space-y-1.5">
              {group.hunks.map((hunk) => (
                <HunkRow
                  key={hunk.ref}
                  hunk={hunk}
                  t={t}
                  onAccept={onReview ? (ref) => onReview(acceptCommand(ref)) : undefined}
                  onRestore={
                    onRestore
                      ? (ref) => onRestore({ taskId, routeId, hunkRef: ref, expectedVersion })
                      : undefined
                  }
                  onSelect={onHunkSelected}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
