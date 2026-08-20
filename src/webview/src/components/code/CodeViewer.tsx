// CodeViewer — 只读内容视图（Task 11）：语言徽标 + 只读标记 + 等宽内容。
// 二进制文件只显示文件级元数据（名称/大小），绝不渲染内容；被截断的超大
// 文本显示截断提示。纯展示组件——数据来自 CodeReader 的 DTO。
import { FileWarning, Lock } from "lucide-react";
import { zhCN } from "../../lib/i18n";
import { formatSize } from "./codeViewModel";

const tZh = (key: string): string => zhCN[key] ?? key;

export interface CodeViewerProps {
  path: string;
  content: string;
  language: string;
  readOnly: true;
  binary: boolean;
  truncated: boolean;
  size: number;
  t?: (key: string) => string;
}

export function CodeViewer({
  path,
  content,
  language,
  readOnly,
  binary,
  truncated,
  size,
  t = tZh,
}: CodeViewerProps): React.JSX.Element | null {
  if (path === "") return null;
  return (
    <section aria-label={t("code.viewer.title")} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-(--color-app-hairline) px-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={path}>
          {path}
        </span>
        <span className="shrink-0 rounded bg-(--color-app-bubble) px-1.5 py-0.5 font-mono text-[10px] text-(--color-app-muted)">
          {language}
        </span>
        {readOnly && (
          <span
            className="flex shrink-0 items-center gap-0.5 text-[10px] text-(--color-app-muted)"
            title={t("code.readonly")}
          >
            <Lock size={10} /> {t("code.readonly")}
          </span>
        )}
      </header>
      {binary ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-(--color-app-muted)">
          <FileWarning size={20} />
          <span className="text-[12px]">{t("code.binary")}</span>
          <span className="font-mono text-[11px]">{formatSize(size)}</span>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          <pre className="code-viewer scrollbar-thin h-full overflow-auto p-2 font-mono text-[11.5px] leading-5 whitespace-pre">
            {content}
          </pre>
          {truncated && (
            <div className="border-t border-(--color-app-hairline) px-2 py-1 text-[10.5px] text-(--color-app-muted)">
              {t("code.truncated")}（{formatSize(size)}）
            </div>
          )}
        </div>
      )}
    </section>
  );
}
