// ValidationSummary — ValidationResult 展示（Task 10）：
// 通过/失败摘要；非 compact 模式失败原因可展开。
import { useState } from "react";
import { ChevronDown, ChevronRight, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { ValidationResult } from "../../../../shared/taskIpc";
import { zhCN } from "../../lib/i18n";

const tZh = (key: string): string => zhCN[key] ?? key;

export interface ValidationSummaryProps {
  validation: ValidationResult | null;
  /** compact：消息流内的单行徽标（不展开详情）。 */
  compact?: boolean;
  t?: (key: string) => string;
}

export function ValidationSummary({ validation, compact = false, t = tZh }: ValidationSummaryProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (validation === null) {
    return (
      <span className="flex items-center gap-1 text-[11px] text-(--color-app-muted)">
        <ShieldQuestion size={12} /> {t("task.validation.none")}
      </span>
    );
  }
  if (validation.success) {
    return (
      <span className="flex items-center gap-1 text-[11px] text-emerald-600">
        <ShieldCheck size={12} /> {t("task.validation.passed")}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => !compact && setOpen((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-red-600"
      >
        <ShieldAlert size={12} /> {t("task.validation.failed")}
        {!compact && (
          <>
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <span className="text-(--color-app-muted)">{t("task.validation.details")}</span>
          </>
        )}
      </button>
      {!compact && open && validation.message && (
        <pre className="scrollbar-thin max-h-40 overflow-auto rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg) p-2 font-mono text-[11px] whitespace-pre-wrap text-(--color-app-text)">
          {validation.message}
        </pre>
      )}
    </div>
  );
}
