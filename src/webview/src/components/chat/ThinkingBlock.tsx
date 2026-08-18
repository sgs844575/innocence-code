import { useState } from "react";
import { BrainCircuit, ChevronRight } from "lucide-react";

export function ThinkingBlock({ text, live }: { text: string; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const secs = Math.max(1, Math.round(text.length / 400)); // 字数近似时长，无服务端时间戳
  return (
    <div className="my-2 overflow-hidden rounded-[10px] border border-(--color-app-hairline) bg-(--color-app-bubble)/40">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-(--color-app-muted) hover:text-(--color-app-text)">
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <BrainCircuit size={12} className={`shrink-0 ${live ? "animate-pulse text-(--color-app-accent)" : ""}`} />
        {live ? (
          <span className="shimmer truncate">{text.slice(-60) || "思考中…"}</span>
        ) : (
          <span>已思考约 {secs} 秒</span>
        )}
      </button>
      {open && (
        <pre className="scrollbar-thin max-h-60 overflow-auto border-t border-(--color-app-hairline) px-3 py-2 text-[11.5px] leading-relaxed text-(--color-app-muted)">{text}</pre>
      )}
    </div>
  );
}
