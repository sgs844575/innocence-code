// TaskChangeCard — 消息流内的任务变更卡（Task 10）：文件数、增删统计
// （+/−行数）、验证状态、checkpoint 标识与「审查」动作。数据来自
// taskViewModel.summarizeChanges；打开动作由宿主接线（缺省禁用）。
import { FileDiff, GitCommitHorizontal, PanelRightOpen } from "lucide-react";
import type { ValidationResult } from "../../../../shared/taskIpc";
import { zhCN } from "../../lib/i18n";
import { ValidationSummary } from "./ValidationSummary";
import type { TaskChangeSummary } from "./taskViewModel";

const tZh = (key: string): string => zhCN[key] ?? key;

export interface TaskChangeCardProps {
  summary: TaskChangeSummary;
  checkpointId: string;
  validation: ValidationResult | null;
  t?: (key: string) => string;
  /** 「审查/打开」——打开审查面板；未接线时按钮禁用。 */
  onReview?: () => void;
}

export function TaskChangeCard({ summary, checkpointId, validation, t = tZh, onReview }: TaskChangeCardProps): React.JSX.Element {
  return (
    <div className="flex max-w-[520px] items-center gap-3 rounded-[14px] border border-(--color-app-hairline) bg-(--color-app-bg) px-3 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-(--color-app-bubble) text-(--color-app-accent)">
        <FileDiff size={15} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2 text-[12.5px]">
          <span>{t("task.change.files").replace("{n}", String(summary.fileCount))}</span>
          <span className="font-mono text-[11.5px] text-emerald-600">+{summary.added}</span>
          <span className="font-mono text-[11.5px] text-red-600">−{summary.removed}</span>
        </div>
        <div className="flex items-center gap-3">
          <ValidationSummary validation={validation} compact t={t} />
          <span
            className="flex items-center gap-1 font-mono text-[10.5px] text-(--color-app-muted)"
            title={t("task.change.checkpoint")}
          >
            <GitCommitHorizontal size={11} /> {checkpointId}
          </span>
        </div>
      </div>
      <button
        type="button"
        disabled={!onReview}
        onClick={onReview}
        className="ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded border border-(--color-app-border) px-2.5 text-[12px] text-(--color-app-text) hover:bg-(--color-app-bubble) disabled:opacity-50"
      >
        <PanelRightOpen size={13} /> {t("task.change.review")}
      </button>
    </div>
  );
}
