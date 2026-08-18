import { useState } from "react";
import { Copy, Quote } from "lucide-react";
import { messageText, type MessagePart } from "../../../../shared/ipc";
import { MarkdownView } from "./MarkdownView";
import { ThinkingBlock } from "./ThinkingBlock";
import { TurnCollapse } from "./TurnCollapse";
import { segmentParts } from "./segmentParts";

interface Props {
  parts: MessagePart[];
  streaming: boolean;
  isLatest: boolean;
  t: (key: string) => string;
  onQuote: (text: string) => void;
}

export function MessageFrame({ parts, streaming, isLatest, t, onQuote }: Props): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(messageText(parts)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const segments = segmentParts(parts);
  return (
    <div className="group/msg">
      <div className="mb-1 flex items-center gap-2">
        <span className="grid size-5 place-items-center rounded-full border border-(--color-app-border) font-mono text-[10px] font-bold text-(--color-app-accent)">&gt;_</span>
        <span className="text-xs font-medium text-(--color-app-muted)">InnocenceCode</span>
        <div className={`ml-auto flex items-center gap-3 text-[11px] text-(--color-app-muted) transition-opacity duration-150 ${isLatest ? "opacity-100" : "opacity-0 group-hover/msg:opacity-100"}`}>
          <button type="button" onClick={copy} className="flex items-center gap-1 hover:text-(--color-app-text)">
            <Copy size={12} />{copied ? t("chat.copied") : t("chat.copy")}
          </button>
          <button type="button" onClick={() => onQuote(messageText(parts))} className="flex items-center gap-1 hover:text-(--color-app-text)">
            <Quote size={12} />{t("chat.quote")}
          </button>
        </div>
      </div>
      {segments.map((seg, i) => {
        if (seg.kind === "thinking") return <ThinkingBlock key={i} text={seg.text} live={streaming} t={t} />;
        if (seg.kind === "tools") return <TurnCollapse key={i} parts={seg.parts} live={streaming} t={t} />;
        return (
          <div key={i} className="min-h-6">
            <MarkdownView source={seg.text} t={t} />
            {streaming && i === segments.length - 1 && <span className="stream-caret" aria-label="streaming" />}
          </div>
        );
      })}
    </div>
  );
}
