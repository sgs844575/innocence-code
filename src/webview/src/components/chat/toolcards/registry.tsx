import type { ToolCallPart, ToolResultPart } from "../../../../../shared/ipc";

/** 工具卡统一接口——任务 11 的完整 registry 按此契约逐工具实现。 */
export interface ToolCardProps {
  call: ToolCallPart;
  result?: ToolResultPart;
  open: boolean;
  onToggle: () => void;
}

export type ToolCard = (props: ToolCardProps) => React.JSX.Element;

/** 兜底卡：工具名 + args 摘要一行，open 时展开 result 明细（三层下钻的第三层）。 */
function FallbackToolCard({ call, result, open, onToggle }: ToolCardProps): React.JSX.Element {
  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-[6px] px-1.5 py-1 text-left font-mono text-[11px] text-(--color-app-muted) hover:bg-(--color-app-accent-soft) hover:text-(--color-app-text)"
      >
        <span className="shrink-0 font-semibold text-(--color-app-accent)">{call.toolName}</span>
        <span className="truncate">{JSON.stringify(call.args)}</span>
        {result ? (
          result.isError ? (
            <span className="ml-auto shrink-0 text-[10px] text-(--color-tool-err)">失败</span>
          ) : (
            result.durationMs != null && (
              <span className="ml-auto shrink-0 text-[10px] text-(--color-app-muted)/60">{result.durationMs}ms</span>
            )
          )
        ) : (
          <span className="ml-auto shrink-0 text-[10px] text-(--color-tool-running)">运行中</span>
        )}
      </button>
      {open && result && (
        <pre className="mt-0.5 ml-1.5 max-h-48 overflow-auto rounded-[6px] bg-(--color-app-accent-soft) p-2 text-[10.5px] leading-relaxed whitespace-pre-wrap text-(--color-app-muted)">{result.content}</pre>
      )}
    </div>
  );
}

/** 最小 registry：任何工具名都返回兜底卡——任务 11 替换为按 toolName 分发的完整实现。 */
export function getToolCard(_toolName: string): ToolCard {
  return FallbackToolCard;
}
