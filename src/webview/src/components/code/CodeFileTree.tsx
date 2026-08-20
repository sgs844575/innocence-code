// CodeFileTree — 只读文件树（Task 11）：消费 buildFileTree 的 view model，
// 目录行静态展示、文件行是选择按钮（treeitem）。无数据获取、无状态。
import { ChevronRight, FileText } from "lucide-react";
import { zhCN } from "../../lib/i18n";
import type { FileTreeNode } from "./codeViewModel";

const tZh = (key: string): string => zhCN[key] ?? key;

export interface CodeFileTreeProps {
  nodes: readonly FileTreeNode[];
  activePath?: string | null;
  t?: (key: string) => string;
  onSelectFile?: (path: string) => void;
}

function NodeRow({
  node,
  depth,
  activePath,
  t,
  onSelectFile,
}: {
  node: FileTreeNode;
  depth: number;
  activePath?: string | null;
  t: (key: string) => string;
  onSelectFile?: (path: string) => void;
}): React.JSX.Element {
  const active = node.type === "file" && node.path === activePath;
  if (node.type === "dir") {
    return (
      <div>
        <div
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded="true"
          style={{ paddingLeft: 8 + depth * 12 }}
          className="flex items-center gap-1 py-0.5 font-mono text-[11.5px] text-(--color-app-muted)"
        >
          <ChevronRight size={12} className="shrink-0" /> {node.name}
        </div>
        <div role="group">
          {node.children.map((child) => (
            <NodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              t={t}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      </div>
    );
  }
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={active}
      title={node.path}
      onClick={() => onSelectFile?.(node.path)}
      style={{ paddingLeft: 8 + depth * 12 }}
      className={`flex w-full items-center gap-1 rounded py-0.5 text-left font-mono text-[11.5px] ${
        active ? "bg-(--color-app-bubble) text-(--color-app-text)" : "text-(--color-app-text) hover:bg-(--color-app-bubble)/50"
      }`}
    >
      <FileText size={12} className="shrink-0 text-(--color-app-muted)" /> {node.name}
    </button>
  );
}

export function CodeFileTree({
  nodes,
  activePath = null,
  t = tZh,
  onSelectFile,
}: CodeFileTreeProps): React.JSX.Element {
  return (
    <div role="tree" aria-label={t("code.tree")} className="code-file-tree py-1">
      {nodes.length === 0 ? (
        <div className="px-2 py-2 text-[11.5px] text-(--color-app-muted)">{t("code.tree.empty")}</div>
      ) : (
        nodes.map((node) => (
          <NodeRow key={node.path} node={node} depth={0} activePath={activePath} t={t} onSelectFile={onSelectFile} />
        ))
      )}
    </div>
  );
}
