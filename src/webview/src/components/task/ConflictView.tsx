// ConflictView — 归因冲突的三方视图（Task 10）：expected（checkpoint 基线）/
// agent（Agent 写入）/ current（当前工作区）并列展示；三个显式动作——保留当前、
// 采用 Agent、让 Agent 重做。绝不静默覆盖：没有显式动作回调时按钮一律禁用。
import { Redo2, Replace, ShieldAlert, ShieldCheck } from "lucide-react";
import { zhCN } from "../../lib/i18n";
import type { ConflictTrio } from "./taskViewModel";

const tZh = (key: string): string => zhCN[key] ?? key;

export interface ConflictViewProps {
  conflicts: ConflictTrio[];
  t?: (key: string) => string;
  /** 保留当前工作区内容（冲突标记为外部修改）。 */
  onKeepCurrent?: (path: string) => void;
  /** 采用 Agent 的写入。 */
  onAdoptAgent?: (path: string) => void;
  /** 让 Agent 基于当前状态重做。 */
  onAskRedo?: (path: string) => void;
}

function Side({
  label,
  content,
  tone,
}: {
  label: string;
  content: string;
  tone: string;
}): React.JSX.Element {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg)">
      <div className={`border-b border-(--color-app-hairline) px-2 py-1 text-[10.5px] font-medium ${tone}`}>
        {label}
      </div>
      <pre className="scrollbar-thin max-h-48 overflow-auto p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap">
        {content}
      </pre>
    </div>
  );
}

export function ConflictView({
  conflicts,
  t = tZh,
  onKeepCurrent,
  onAdoptAgent,
  onAskRedo,
}: ConflictViewProps): React.JSX.Element | null {
  if (conflicts.length === 0) return null;
  return (
    <section
      aria-label={t("task.conflict.title")}
      className="space-y-3 rounded-xl border border-(--color-app-hairline) bg-(--color-app-panel) p-3"
    >
      <div className="flex items-center gap-2 text-[12.5px] font-semibold">
        <ShieldAlert size={14} className="text-red-600" /> {t("task.conflict.title")}
      </div>
      {conflicts.map((conflict) => (
        <div
          key={conflict.path}
          className="space-y-2 rounded-lg border border-(--color-app-hairline) p-2"
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate font-mono text-[12px]" title={conflict.path}>
              {conflict.path}
            </span>
            {conflict.reason && (
              <span className="shrink-0 text-[11px] text-(--color-app-muted)" title={t("task.conflict.reason")}>
                {conflict.reason}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Side label={t("task.conflict.expected")} content={conflict.expected} tone="text-(--color-app-muted)" />
            <Side label={t("task.conflict.agent")} content={conflict.agent} tone="text-emerald-600" />
            <Side label={t("task.conflict.current")} content={conflict.current} tone="text-(--color-app-accent)" />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!onKeepCurrent}
              onClick={() => onKeepCurrent?.(conflict.path)}
              className="flex h-7 items-center gap-1.5 rounded border border-(--color-app-border) px-2.5 text-[12px] hover:bg-(--color-app-bubble) disabled:opacity-50"
            >
              <ShieldCheck size={13} /> {t("task.conflict.keepCurrent")}
            </button>
            <button
              type="button"
              disabled={!onAdoptAgent}
              onClick={() => onAdoptAgent?.(conflict.path)}
              className="flex h-7 items-center gap-1.5 rounded border border-(--color-app-border) px-2.5 text-[12px] hover:bg-(--color-app-bubble) disabled:opacity-50"
            >
              <Replace size={13} /> {t("task.conflict.adoptAgent")}
            </button>
            <button
              type="button"
              disabled={!onAskRedo}
              onClick={() => onAskRedo?.(conflict.path)}
              className="flex h-7 items-center gap-1.5 rounded border border-(--color-app-border) px-2.5 text-[12px] hover:bg-(--color-app-bubble) disabled:opacity-50"
            >
              <Redo2 size={13} /> {t("task.conflict.redo")}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
