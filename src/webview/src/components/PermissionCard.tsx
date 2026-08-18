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

  return (
    <div
      role="alertdialog"
      aria-label={t("permission.card.title")}
      className="mx-auto mb-2 w-full max-w-3xl rounded-xl border border-amber-500/40 bg-(--color-app-panel) px-4 py-3 shadow-sm"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-(--color-app-text)">
        <ShieldQuestion size={16} className="text-amber-500" />
        {t("permission.card.title")}
        <code className="rounded-md bg-(--color-app-bubble) px-1.5 py-0.5 font-mono text-xs">
          {request.toolName}
        </code>
      </div>
      <pre className="scrollbar-thin mt-2 max-h-32 overflow-auto rounded-lg bg-(--color-app-bubble) p-2 font-mono text-xs text-(--color-app-muted)">
        {argsText}
      </pre>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => onRespond(request.requestId, "deny")}
          className="rounded-lg border border-(--color-app-border) px-3 py-1.5 text-xs text-(--color-app-muted) transition-colors hover:bg-(--color-app-bubble)"
        >
          {t("permission.card.deny")}
        </button>
        <button
          type="button"
          onClick={() => onRespond(request.requestId, "allowSession")}
          className="rounded-lg border border-(--color-app-border) px-3 py-1.5 text-xs text-(--color-app-text) transition-colors hover:bg-(--color-app-bubble)"
        >
          {t("permission.card.allowSession")}
        </button>
        <button
          type="button"
          onClick={() => onRespond(request.requestId, "allow")}
          className="rounded-lg bg-(--color-app-accent) px-3 py-1.5 text-xs font-medium text-(--color-app-accent-fg) transition-transform active:scale-95"
        >
          {t("permission.card.allow")}
        </button>
      </div>
    </div>
  );
}
