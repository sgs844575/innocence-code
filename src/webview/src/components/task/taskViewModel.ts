// taskViewModel — 纯函数映射 IPC DTO → 渲染侧 view model（Task 10）。
// 审查/路线/冲突面板的状态由 IPC 推送的 DTO 驱动：这里只做分组、计数与
// 三方视图组装，绝不在组件里实现任务 reducer。
//
// TaskHunk 与 task-core 的 Hunk 结构兼容（ref/path/before/after/context/
// status），组件只消费 props，不直接 import 任何 workspace 包。

export type TaskHunkStatus = "pending" | "accepted" | "restored" | "conflict";

/** 渲染侧 hunk 输入（与 @innocencecode/task-core 的 Hunk 结构等价）。 */
export interface TaskHunk {
  ref: string;
  path: string;
  before: string;
  after: string;
  context: string[];
  status: TaskHunkStatus;
}

/** 按文件分组的 hunk 列表 + 该文件的 +/- 行数统计。 */
export interface FileReviewGroup {
  path: string;
  hunks: TaskHunk[];
  added: number;
  removed: number;
}

/** TaskChangeCard 的汇总统计。 */
export interface TaskChangeSummary {
  fileCount: number;
  added: number;
  removed: number;
  accepted: number;
  pending: number;
  restored: number;
  conflicts: number;
  /** 尚未审查的 hunk 数（pending + conflict）——完成门槛用。 */
  unreviewed: number;
}

/** 路线信息：TaskRouteSummary 的超集（补 forkTurnId 与 workspaceKind）。 */
export interface RouteInfo {
  routeId: string;
  parentRouteId: string | null;
  forkTurnId: string | null;
  checkpointId: string;
  workspaceRoot?: string;
  workspaceKind: string;
}

/** 嵌套路线树节点（depth 从 0 起）。 */
export interface RouteNode extends RouteInfo {
  depth: number;
  children: RouteNode[];
}

/** 冲突三方视图：期望（checkpoint 基线）/ Agent 修改 / 当前工作区。 */
export interface ConflictTrio {
  path: string;
  reason: string;
  expected: string;
  agent: string;
  current: string;
}

/** 统计非空行数（diff 片段按行计；结尾空行不计）。 */
export function countLines(text: string): number {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/**
 * 按文件分组 hunks：保持首次出现顺序；组内保持传入顺序。
 * 纯函数——不修改输入数组或 hunk 对象。
 */
export function groupHunksByFile(hunks: readonly TaskHunk[]): FileReviewGroup[] {
  const groups: FileReviewGroup[] = [];
  const byPath = new Map<string, FileReviewGroup>();
  for (const hunk of hunks) {
    let group = byPath.get(hunk.path);
    if (!group) {
      group = { path: hunk.path, hunks: [], added: 0, removed: 0 };
      byPath.set(hunk.path, group);
      groups.push(group);
    }
    group.hunks.push(hunk);
    group.added += countLines(hunk.after);
    group.removed += countLines(hunk.before);
  }
  return groups;
}

/** 汇总全部 hunks：文件数、增删行数、各审查状态计数与未审查数。 */
export function summarizeChanges(hunks: readonly TaskHunk[]): TaskChangeSummary {
  const summary: TaskChangeSummary = {
    fileCount: new Set(hunks.map((h) => h.path)).size,
    added: 0,
    removed: 0,
    accepted: 0,
    pending: 0,
    restored: 0,
    conflicts: 0,
    unreviewed: 0,
  };
  for (const hunk of hunks) {
    summary.added += countLines(hunk.after);
    summary.removed += countLines(hunk.before);
    if (hunk.status === "accepted") summary.accepted += 1;
    else if (hunk.status === "pending") summary.pending += 1;
    else if (hunk.status === "restored") summary.restored += 1;
    else summary.conflicts += 1;
  }
  summary.unreviewed = summary.pending + summary.conflicts;
  return summary;
}

/**
 * 组装路线树：children 按“父先于子出现”挂接；父不在列表中的节点按根
 * 处理（孤儿容错——事件回放顺序不保证）。同层保持传入顺序。
 */
export function buildRouteTree(routes: readonly RouteInfo[]): RouteNode[] {
  const nodes = new Map<string, RouteNode>();
  const roots: RouteNode[] = [];
  const pendingChildren: Array<{ parent: string; node: RouteNode }> = [];

  for (const route of routes) {
    const node: RouteNode = { ...route, depth: 0, children: [] };
    nodes.set(route.routeId, node);
    if (route.parentRouteId !== null && !nodes.has(route.parentRouteId)) {
      // 父尚未出现：先挂起，等父到达再接（也覆盖父永不出现的孤儿情况）
      pendingChildren.push({ parent: route.parentRouteId, node });
    } else if (route.parentRouteId !== null) {
      attach(nodes.get(route.parentRouteId)!, node);
    } else {
      roots.push(node);
    }
  }

  for (const { parent, node } of pendingChildren) {
    const parentNode = nodes.get(parent);
    if (parentNode) attach(parentNode, node);
    else roots.push(node);
  }
  return roots;

  function attach(parent: RouteNode, node: RouteNode): void {
    node.depth = parent.depth + 1;
    parent.children.push(node);
  }
}

/**
 * 从 hunk 与当前工作区内容组装冲突三方：expected = checkpoint 基线
 * （hunk.before），agent = Agent 写入（hunk.after），current = 工作区现状。
 */
export function buildConflictTrio(hunk: TaskHunk, currentContent: string, reason = ""): ConflictTrio {
  return {
    path: hunk.path,
    reason,
    expected: hunk.before,
    agent: hunk.after,
    current: currentContent,
  };
}
