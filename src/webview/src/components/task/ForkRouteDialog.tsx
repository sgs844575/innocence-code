import { useEffect, useState } from "react";
import { GitBranch, X } from "lucide-react";
import type { TaskForkRouteRequest, TaskRouteSummary } from "../../../../shared/taskIpc";

interface Props {
  open: boolean;
  request: TaskForkRouteRequest;
  checkpointId: string;
  onClose: () => void;
  createRoute: (request: TaskForkRouteRequest) => Promise<TaskRouteSummary & { prompt: string }>;
  onSwitchRoute: (routeId: string, prompt: string) => void;
}

export function ForkRouteDialog({
  open,
  request,
  checkpointId,
  onClose,
  createRoute,
  onSwitchRoute,
}: Props): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [editedText, setEditedText] = useState(request.editedText ?? "");

  useEffect(() => {
    if (open) {
      setError("");
      setEditedText(request.editedText ?? "");
    }
  }, [open, request.sourceTurnId, request.editedText]);

  if (!open) return <></>;

  const confirm = async () => {
    setPending(true);
    setError("");
    try {
      const route = await createRoute(
        request.mode === "edit-user" ? { ...request, editedText } : request,
      );
      onSwitchRoute(route.routeId, route.prompt);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center px-4">
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="fork-route-title"
        className="relative w-full max-w-[440px] border border-(--color-app-border) bg-(--color-app-panel) shadow-(--shadow-pop)"
      >
        <header className="flex h-12 items-center border-b border-(--color-app-hairline) px-4">
          <h2 id="fork-route-title" className="text-[14px] font-semibold">创建隔离路线</h2>
          <button
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
            disabled={pending}
            className="ml-auto grid size-8 place-items-center text-(--color-app-muted) hover:bg-(--color-app-bubble)"
          >
            <X size={16} />
          </button>
        </header>
        <dl className="grid grid-cols-[112px_1fr] gap-y-3 px-4 py-4 text-[12.5px]">
          <dt className="text-(--color-app-muted)">父路线</dt>
          <dd className="font-mono">{request.sourceRouteId}</dd>
          <dt className="text-(--color-app-muted)">目标 checkpoint</dt>
          <dd className="font-mono">{checkpointId}</dd>
          <dt className="text-(--color-app-muted)">工作区</dt>
          <dd>隔离 worktree</dd>
          <dt className="text-(--color-app-muted)">原路线</dt>
          <dd>原路线保持不变</dd>
        </dl>
        {request.mode === "edit-user" && (
          <label className="flex flex-col gap-1 border-t border-(--color-app-hairline) px-4 py-3 text-[12.5px]">
            修改后的消息
            <textarea
              value={editedText}
              onChange={(event) => setEditedText(event.target.value)}
              rows={4}
              disabled={pending}
              className="scrollbar-thin resize-none rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg) p-2 outline-none"
            />
          </label>
        )}
        {error && <p role="alert" className="border-t border-(--color-app-hairline) px-4 py-2 text-[12px] text-red-600">{error}</p>}
        <footer className="flex justify-end gap-2 border-t border-(--color-app-hairline) px-4 py-3">
          <button type="button" onClick={onClose} disabled={pending} className="h-8 border border-(--color-app-border) px-3 text-[12px]">取消</button>
          <button
            type="button"
            onClick={confirm}
            disabled={pending}
            className="flex h-8 items-center gap-1.5 bg-(--color-app-accent) px-3 text-[12px] font-medium text-(--color-app-accent-fg) disabled:opacity-60"
          >
            <GitBranch size={14} />
            {pending ? "创建中" : "创建路线"}
          </button>
        </footer>
      </section>
    </div>
  );
}
