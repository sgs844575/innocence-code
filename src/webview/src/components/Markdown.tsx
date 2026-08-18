// Minimal markdown renderer covering what the mock backend emits: fenced
// code blocks (with copy button), ordered/unordered lists, blockquotes,
// headings, bold and inline code. Intentionally dependency-free; swap for a
// full parser when real model output needs it.
import { Fragment, useState, type ReactNode } from "react";

interface Block {
  kind: "code" | "list" | "quote" | "heading" | "paragraph";
  text: string;
  ordered?: boolean;
  lang?: string;
}

export function Markdown({ source }: { source: string }): ReactNode {
  const blocks = parse(source);
  return (
    <div className="space-y-2.5">
      {blocks.map((b, i) => (
        <Fragment key={i}>{renderBlock(b)}</Fragment>
      ))}
    </div>
  );
}

function parse(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || undefined;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) buf.push(lines[i++]!);
      i++; // closing fence
      blocks.push({ kind: "code", text: buf.join("\n"), lang });
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        buf.push(lines[i++]!.replace(/^\s*[-*]\s+/, ""));
      }
      blocks.push({ kind: "list", text: buf.join("\n"), ordered: false });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        buf.push(lines[i++]!.replace(/^\s*\d+\.\s+/, ""));
      }
      blocks.push({ kind: "list", text: buf.join("\n"), ordered: true });
      continue;
    }

    if (line.startsWith("> ")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) {
        buf.push(lines[i++]!.slice(2));
      }
      blocks.push({ kind: "quote", text: buf.join(" ") });
      continue;
    }

    if (/^#{1,4}\s+/.test(line)) {
      blocks.push({ kind: "heading", text: lines[i++]!.replace(/^#{1,4}\s+/, "") });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.startsWith("```") &&
      !lines[i]!.startsWith("> ") &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]!) &&
      !/^#{1,4}\s+/.test(lines[i]!)
    ) {
      buf.push(lines[i++]!);
    }
    blocks.push({ kind: "paragraph", text: buf.join(" ") });
  }

  return blocks;
}

function renderBlock(b: Block): ReactNode {
  switch (b.kind) {
    case "code":
      return <CodeBlock code={b.text} lang={b.lang} />;
    case "heading":
      return <h3 className="pt-1 font-semibold">{inline(b.text)}</h3>;
    case "quote":
      return (
        <blockquote className="border-l-2 border-(--color-app-border) pl-3 text-(--color-app-muted)">
          {inline(b.text)}
        </blockquote>
      );
    case "list": {
      const items = b.text.split("\n");
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag className={`list-inside space-y-1 pl-1 ${b.ordered ? "list-decimal" : "list-disc"}`}>
          {items.map((item, i) => (
            <li key={i}>{inline(item)}</li>
          ))}
        </Tag>
      );
    }
    default:
      return <p>{inline(b.text)}</p>;
  }
}

function CodeBlock({ code, lang }: { code: string; lang?: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  // Dark panel in both themes, like iOS/macOS code surfaces.
  return (
    <div className="overflow-hidden rounded-xl border border-(--color-app-hairline) bg-[#232326] text-[#ececf0] shadow-(--shadow-card)">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-[11px] text-white/50">{lang ?? "text"}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/70 transition-colors hover:bg-white/20 hover:text-white"
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="scrollbar-thin overflow-x-auto p-3 font-mono text-[13px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function inline(text: string): ReactNode[] {
  // Split on `code`, **bold** markers; leftmost-first, no nesting.
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} className="rounded bg-(--color-app-bubble) px-1 py-0.5 font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}
