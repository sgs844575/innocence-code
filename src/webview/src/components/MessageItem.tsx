import { useState } from "react";
import type { ChatMessage } from "../../../shared/ipc";
import { Markdown } from "./Markdown";

export function MessageItem({ t, message }: { t: (key: string) => string; message: ChatMessage }): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-(--color-app-bubble) px-4 py-2.5 text-sm leading-relaxed">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="group">
      <div className="mb-1 flex items-center gap-2">
        <span className="grid size-5 place-items-center rounded-md border border-(--color-app-border) font-mono text-[10px] font-bold text-(--color-app-accent)">
          &gt;_
        </span>
        <span className="text-xs font-medium text-(--color-app-muted)">InnocenceCode</span>
        {message.content.length > 0 && (
          <button
            type="button"
            onClick={copy}
            className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-(--color-app-muted) opacity-0 transition-opacity group-hover:opacity-100"
          >
            {copied ? t("chat.copied") : t("chat.copy")}
          </button>
        )}
      </div>
      <div className="min-h-6 text-sm leading-relaxed">
        <Markdown source={message.content} />
        {message.streaming && <span className="stream-caret" aria-label="streaming" />}
      </div>
    </div>
  );
}
