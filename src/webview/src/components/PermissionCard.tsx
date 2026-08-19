import { ShieldQuestion } from "lucide-react";
import type { ChatPermissionEvent, PermissionChoice } from "../../../shared/ipc";

interface Props {
  t: (key: string) => string;
  request: ChatPermissionEvent;
  onRespond: (requestId: string, choice: PermissionChoice) => void;
}

/** Approval card shown while the agent waits for a tool-call decision. */
export function PermissionCard({ t, request, onRespond }: Props): React.JSX.Element {
  const argsText = JSON.stringify(request.args, null, 2);
  const { resource } = request;

  return (
    <div
      role="alertdialog"
      aria-label={t("permission.card.title")}
      className="mx-auto mb-2 w-full max-w-3xl rounded-[10px] border border-(--color-tool-warn)/40 bg-(--color-app-panel) px-4 py-3 shadow-(--shadow-card)"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-(--color-app-text)">
        <ShieldQuestion size={16} className="shrink-0 text-(--color-tool-warn)" />
        {t("permission.card.title")}
        <code className="rounded-full bg-(--color-app-bubble) px-2 py-0.5 font-mono text-xs">
          {request.toolName}
        </code>
      </div>
      {/* 稳定资源摘要：kind/action/scope 均为脱敏持久化 token（raw 值
          不出 core），一眼看清这次批准到底放行了什么。 */}
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-xs text-(--color-app-text)">
        <code className="rounded-full bg-(--color-app-bubble) px-2 py-0.5">{resource.action}</code>
        <code className="rounded-full bg-(--color-app-bubble) px-2 py-0.5">{resource.kind}</code>
        <code
          className="min-w-0 flex-1 basis-24 truncate rounded-md bg-(--color-app-bubble) px-2 py-0.5 text-(--color-app-muted)"
          title={resource.scope}
          data-testid="permission-resource-scope"
        >
          {resource.scope}
        </code>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer select-none text-xs text-(--color-app-muted) transition-colors hover:text-(--color-app-text)">
          {t("permission.card.args")}
        </summary>
        <pre className="scrollbar-thin mt-2 max-h-32 overflow-auto rounded-xl bg-(--color-app-bubble) p-2 font-mono text-xs text-(--color-app-muted)">
          {argsText}
        </pre>
      </details>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => onRespond(request.requestId, "deny")}
          className="rounded-full bg-(--color-app-bubble) px-3.5 py-1.5 text-xs text-(--color-app-muted) transition-colors hover:bg-(--color-app-border) hover:text-(--color-app-text)"
        >
          {t("permission.card.deny")}
        </button>
        <button
          type="button"
          onClick={() => onRespond(request.requestId, "allowSession")}
          className="rounded-full border border-(--color-app-border) px-3.5 py-1.5 text-xs text-(--color-app-text) transition-colors hover:bg-(--color-app-bubble)"
        >
          {t("permission.card.allowSession")}
        </button>
        <button
          type="button"
          onClick={() => onRespond(request.requestId, "allow")}
          className="rounded-full bg-(--color-app-accent) px-3.5 py-1.5 text-xs font-medium text-(--color-app-accent-fg) shadow-md transition-transform active:scale-95"
        >
          {t("permission.card.allow")}
        </button>
      </div>
    </div>
  );
}
