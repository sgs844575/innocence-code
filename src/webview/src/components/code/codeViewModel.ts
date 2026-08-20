// codeViewModel — 纯函数映射 code IPC DTO → 渲染侧 view model（Task 11）。
// 只做树组装与展示格式化；内容/语言判定来自 main 的 CodeReader 返回值，
// 组件绝不直接触碰 IPC 或文件系统。

/** 文件树节点：目录递归展开，文件是叶子。 */
export interface FileTreeNode {
  name: string;
  /** 目录：拼接路径；文件：完整 "/"-分隔相对路径。 */
  path: string;
  type: "dir" | "file";
  children: FileTreeNode[];
}

/**
 * 从 "/"-分隔相对路径组装文件树：目录在前、同级按名称排序（大小写不敏
 * 感），保持稳定输出。纯函数——不修改输入。
 */
export function buildFileTree(paths: readonly string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", path: "", type: "dir", children: [] };
  const dirs = new Map<string, FileTreeNode>([["", root]]);

  const dirOf = (dirPath: string): FileTreeNode => {
    let node = dirs.get(dirPath);
    if (node) return node;
    const slash = dirPath.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : dirPath.slice(0, slash);
    const name = slash === -1 ? dirPath : dirPath.slice(slash + 1);
    node = { name, path: dirPath, type: "dir", children: [] };
    dirs.set(dirPath, node);
    dirOf(parentPath).children.push(node);
    return node;
  };

  for (const filePath of paths) {
    const slash = filePath.lastIndexOf("/");
    const parent = slash === -1 ? root : dirOf(filePath.slice(0, slash));
    parent.children.push({
      name: slash === -1 ? filePath : filePath.slice(slash + 1),
      path: filePath,
      type: "file",
      children: [],
    });
  }

  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    for (const node of nodes) sortNodes(node.children);
    return nodes;
  };

  return sortNodes(root.children);
}

/** 展示用大小格式：字节 / KB / MB（向上取整到 1 位有效）。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
