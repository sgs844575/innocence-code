import { useEffect, useMemo, useState } from "react";
import { codeToHtml, type BundledLanguage } from "shiki";

const MAX_COLLAPSED_LINES = 12;

export function CodeBlock({ lang, code }: { lang: string; code: string }): React.JSX.Element {
  const [html, setHtml] = useState("");
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("electron-dark");
  const lines = useMemo(() => code.split("\n"), [code]);
  const over = lines.length > MAX_COLLAPSED_LINES;

  useEffect(() => {
    let alive = true;
    codeToHtml(code, { lang: lang as BundledLanguage, theme: dark ? "material-theme-darker" : "one-light" })
      .then((h) => { if (alive) setHtml(h); })
      .catch(() => { if (alive) setHtml(""); }); // 未知语言：纯 pre 回退
    return () => { alive = false; };
  }, [code, lang, dark]);

  return (
    <div className="code-block overflow-hidden rounded-xl border border-(--color-app-hairline) bg-(--color-code-bg) text-(--color-code-fg) shadow-(--shadow-card)">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-[11px] text-white/50">{lang}</span>
        <div className="flex items-center gap-2 text-[11px]">
          {over && (
            <button type="button" onClick={() => setExpanded((v) => !v)} className="text-white/50 hover:text-white/80">
              {expanded ? "收起" : `展开全部 ${lines.length} 行`}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(code).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            className="rounded-full bg-white/10 px-2 py-0.5 text-white/70 hover:bg-white/20 hover:text-white"
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      <div className={`scrollbar-thin overflow-x-auto ${over && !expanded ? "code-fade" : ""}`}>
        {html ? (
          <div className="code-html p-3 font-mono text-[13px] leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="p-3 font-mono text-[13px] leading-relaxed"><code>{code}</code></pre>
        )}
      </div>
    </div>
  );
}
