import { isValidElement, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { CodeBlock } from "./CodeBlock";
import { zhCN } from "../../lib/i18n";

// t 未注入（如独立测试直接渲染）时退化为 zhCN 查表——CodeBlock 的 code.* 键
// 由此兜底；真实链路里 MessageFrame 会传入随 locale 的 t。
const tZh = (key: string): string => zhCN[key] ?? key;

/** Fenced-block code text may arrive as a plain string, or (while a fence is
 *  still streaming) wrapped in a single child element — mirror streamdown's
 *  own extraction so both shapes work. */
function codeTextOf(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (isValidElement<{ children?: ReactNode }>(children) && typeof children.props.children === "string") {
    return children.props.children;
  }
  return "";
}

export function MarkdownView({ source, t = tZh, animated }: { source: string; t?: (key: string) => string; animated?: boolean }): React.JSX.Element {
  return (
    <div className="md-body text-sm leading-relaxed">
      <Streamdown
        // 流式期间按词淡入（animate 插件按 prevContentLength 去重，只动画
        // 新增文字，不重放历史）；结束后 animated=false 退回静态渲染。
        animated={animated ? { animation: "fadeIn", duration: 400, easing: "ease-out", sep: "word", stagger: 30 } : false}
        components={{
          code: (props) => {
            const { className, children } = props;
            const lang = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "";
            const text = codeTextOf(children).replace(/\n$/, "");
            // streamdown's default <pre> marks fenced blocks with data-block
            // (cloneElement) — the same signal the library's own code renderer
            // uses to tell block code from inline code.
            if (!("data-block" in props)) {
              return <code className="rounded bg-(--color-app-bubble) px-1 py-0.5 font-mono text-[0.9em]">{children}</code>;
            }
            return <CodeBlock lang={lang} code={text} t={t} />;
          },
        }}
      >
        {source}
      </Streamdown>
    </div>
  );
}
