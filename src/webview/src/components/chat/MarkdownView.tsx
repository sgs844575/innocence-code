import { isValidElement, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { CodeBlock } from "./CodeBlock";

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

export function MarkdownView({ source }: { source: string }): React.JSX.Element {
  return (
    <div className="md-body text-sm leading-relaxed">
      <Streamdown
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
            return <CodeBlock lang={lang} code={text} />;
          },
        }}
      >
        {source}
      </Streamdown>
    </div>
  );
}
