// RecoveryBanner — 恢复/失败状态的可见告警条（Task 12）。纯展示：文案键、
// 可选重试（worktree 失败保留的重试命令 → task:recover）与关闭。状态来源
// 是 useWorkbenchState 的 recovery 切片；门禁（writeToolsBlocked/
// completeBlocked）在 hooks/App 层，与告警同源。
interface RecoveryBannerProps {
  message: string;
  /** worktree 失败的重试入口（缺省 = 无可重试的失败）。 */
  onRetry?: () => void;
  onDismiss: () => void;
  retryLabel: string;
  dismissLabel: string;
}

export function RecoveryBanner({
  message,
  onRetry,
  onDismiss,
  retryLabel,
  dismissLabel,
}: RecoveryBannerProps): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-700"
    >
      <span className="min-w-0 truncate" title={message}>
        {message}
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="h-6 shrink-0 rounded border border-amber-600/50 px-2 text-[11px] hover:bg-amber-500/20"
        >
          {retryLabel}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="ml-auto h-6 shrink-0 rounded px-2 text-[11px] hover:bg-amber-500/20"
      >
        {dismissLabel}
      </button>
    </div>
  );
}
