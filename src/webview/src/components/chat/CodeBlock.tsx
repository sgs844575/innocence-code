import { useEffect, useMemo, useState } from "react";
import { codeToHtml, type BundledLanguage } from "shiki";
import { zhCN } from "../../lib/i18n";

const MAX_COLLAPSED_LINES = 12;

// t prop 未注入时的兜底：直接查 zhCN 表（无 locale 状态，权衡见 MarkdownView）。
const tZh = (key: string): string => zhCN[key] ?? key;

export function CodeBlock({ lang, code, t = tZh }: { lang: string; code: string; t?: (key: string) => string }): React.JSX.Element {
  const [html, setHtml] = useState("");
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => code.split("\n"), [code]);
  const over = lines.length > MAX_COLLAPSED_LINES;

  useEffect(() => {
    let alive = true;
    codeToHtml(code, {
      lang: lang as BundledLanguage,
      themes: { light: "one-light", dark: "material-theme-darker" },
      defaultColor: false,
    })
      .then((h) => { if (alive) setHtml(h); })
      .catch(() => { if (alive) setHtml(""); }); // 未知语言：纯 pre 回退
    return () => { alive = false; };
  }, [code, lang]);

  return (
    <div className="code-block overflow-hidden rounded-xl border border-(--color-app-hairline) bg-(--color-code-bg) text-(--color-code-fg) shadow-(--shadow-card)">
      <div className="flex items-center justify-between border-b border-(--color-app-hairline) px-3 py-1.5">
        <span className="font-mono text-[11px] text-(--color-app-muted)">{lang}</span>
        <div className="flex items-center gap-2 text-[11px]">
          {over && (
            <button type="button" onClick={() => setExpanded((v) => !v)} className="text-(--color-app-muted) hover:text-(--color-app-text)">
              {expanded ? t("code.collapse") : t("code.expand").replace("{n}", String(lines.length))}
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
            className="rounded-full bg-(--color-code-control-bg) px-2 py-0.5 text-(--color-code-control-fg) hover:bg-(--color-code-control-bg-hover) hover:text-(--color-code-control-fg-hover)"
          >
            {copied ? t("code.copied") : t("code.copy")}
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
