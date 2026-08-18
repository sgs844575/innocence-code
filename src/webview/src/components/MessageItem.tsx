import { useState } from "react";
import { messageText, type ChatMessage } from "../../../shared/ipc";
import { Markdown } from "./Markdown";

export function MessageItem({ t, message }: { t: (key: string) => string; message: ChatMessage }): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard.writeText(messageText(message.parts)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (message.role === "user") {
    // iMessage-style tinted bubble with a corner tail notch.
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-3xl rounded-br-lg bg-[linear-gradient(135deg,var(--color-app-accent),color-mix(in_srgb,var(--color-app-accent)_72%,#2563eb))] px-4 py-2.5 text-sm leading-relaxed text-(--color-app-accent-fg) shadow-md shadow-black/10">
          {messageText(message.parts)}
        </div>
      </div>
    );
  }

  return (
    <div className="group card px-4 py-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="grid size-5 place-items-center rounded-full border border-(--color-app-border) font-mono text-[10px] font-bold text-(--color-app-accent)">
          &gt;_
        </span>
        <span className="text-xs font-medium text-(--color-app-muted)">InnocenceCode</span>
        {messageText(message.parts).length > 0 && (
          <button
            type="button"
            onClick={copy}
            className="ml-auto rounded-full border border-(--color-app-hairline) px-2.5 py-0.5 text-[11px] text-(--color-app-muted) opacity-0 transition-opacity group-hover:opacity-100"
          >
            {copied ? t("chat.copied") : t("chat.copy")}
          </button>
        )}
      </div>
      <div className="min-h-6 text-sm leading-relaxed">
        <Markdown source={messageText(message.parts)} />
        {message.streaming && <span className="stream-caret" aria-label="streaming" />}
      </div>
    </div>
  );
}
