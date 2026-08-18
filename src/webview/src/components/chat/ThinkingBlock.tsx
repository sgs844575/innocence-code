import { useState } from "react";
import { BrainCircuit, ChevronRight } from "lucide-react";

export function ThinkingBlock({ text, live, t }: { text: string; live: boolean; t: (key: string) => string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const secs = Math.max(1, Math.round(text.length / 400)); // 字数近似时长，无服务端时间戳
  return (
    <div className="my-2 overflow-hidden rounded-[10px] border border-(--color-app-hairline) bg-(--color-app-bubble)/40">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-[11px] leading-relaxed text-(--color-app-muted) hover:text-(--color-app-text)">
        <ChevronRight size={12} className={`mt-[3px] shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <BrainCircuit size={12} className={`mt-[3px] shrink-0 ${live ? "animate-pulse text-(--color-app-accent)" : ""}`} />
        {live ? (
          // 多行换行的思考预览：取尾部约 400 字符，限高渐隐，shimmer 流光
          // 作用在整块文字上——过长不再单行截断。
          <span className="shimmer think-preview min-w-0 flex-1">
            {text.slice(-400) || t("chat.thinking.live")}
          </span>
        ) : (
          <span>{t("chat.thinking.done").replace("{n}", String(secs))}</span>
        )}
      </button>
      {open && (
        <pre className="scrollbar-thin max-h-60 overflow-y-auto whitespace-pre-wrap break-words border-t border-(--color-app-hairline) px-3 py-2 text-[11.5px] leading-relaxed text-(--color-app-muted)">{text}</pre>
      )}
    </div>
  );
}
