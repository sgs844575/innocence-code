// RoutePanel — 路线面板（Task 10）：parent/child、fork turn、checkpoint、
// workspace kind。切换路线调用 route IPC（switchRoute prop），等 main 带回
// 完整 view model 后才更新 UI——切换期间显示「切换中」且不闪旧状态。
import { useEffect, useState } from "react";
import { CornerDownRight, GitBranch, GitCommitHorizontal, Loader2 } from "lucide-react";
import type { TaskSwitchRouteRequest } from "../../../../shared/taskIpc";
import { zhCN } from "../../lib/i18n";
import { buildRouteTree, type RouteInfo, type RouteNode } from "./taskViewModel";

const tZh = (key: string): string => zhCN[key] ?? key;

/** 切换成功后 main 回传的完整路线 view model。 */
export interface RoutePanelModel {
  routes: RouteInfo[];
  activeRouteId: string;
}

export interface RoutePanelProps {
  taskId: string;
  routes: RouteInfo[];
  activeRouteId: string;
  t?: (key: string) => string;
  /** route IPC：必须等它 resolve 完整 view model 后才更新 UI。 */
  switchRoute: (request: TaskSwitchRouteRequest) => Promise<RoutePanelModel>;
}

function workspaceKindLabel(kind: string, t: (key: string) => string): string {
  return kind === "git" ? t("task.route.workspace.git") : t("task.route.workspace.snapshot");
}

export function RoutePanel({ taskId, routes, activeRouteId, t = tZh, switchRoute }: RoutePanelProps): React.JSX.Element {
  const [model, setModel] = useState<RoutePanelModel>({ routes, activeRouteId });
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // props 是 IPC view model 的最新快照：外部刷新（事件推送）到达时同步。
  useEffect(() => {
    setModel({ routes, activeRouteId });
  }, [routes, activeRouteId]);

  const switchTo = async (routeId: string) => {
    if (switchingTo !== null || routeId === model.activeRouteId) return;
    setSwitchingTo(routeId);
    setError(null);
    try {
      const next = await switchRoute({ taskId, routeId });
      setModel(next); // 完整 view model 到达才更新——无 stale flash
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSwitchingTo(null);
    }
  };

  const renderNode = (node: RouteNode): React.JSX.Element => {
    const active = node.routeId === model.activeRouteId;
    const switching = switchingTo === node.routeId;
    return (
      <div key={node.routeId} className="space-y-1">
        <div
          style={{ marginLeft: node.depth * 16 }}
          className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${
            active ? "bg-(--color-app-bubble)" : "hover:bg-(--color-app-bubble)/50"
          }`}
        >
          <GitBranch
            size={13}
            className={`shrink-0 ${active ? "text-(--color-app-accent)" : "text-(--color-app-muted)"}`}
          />
          <span className="font-mono text-[12px]">{node.routeId}</span>
          {active && (
            <span className="rounded bg-(--color-app-accent) px-1.5 py-0.5 text-[10px] text-(--color-app-accent-fg)">
              {t("task.route.active")}
            </span>
          )}
          {switching && (
            <span className="flex items-center gap-1 text-[10.5px] text-(--color-app-muted)">
              <Loader2 size={11} className="animate-spin" /> {t("task.route.switching")}
            </span>
          )}
          {node.forkTurnId !== null && (
            <span
              className="flex shrink-0 items-center gap-0.5 font-mono text-[10.5px] text-(--color-app-muted)"
              title={t("task.route.forkTurn")}
            >
              <CornerDownRight size={11} /> {node.forkTurnId}
            </span>
          )}
          <span
            className="flex shrink-0 items-center gap-0.5 font-mono text-[10.5px] text-(--color-app-muted)"
            title={t("task.route.checkpoint")}
          >
            <GitCommitHorizontal size={11} /> {node.checkpointId}
          </span>
          <span className="shrink-0 text-[10.5px] text-(--color-app-muted)">
            {workspaceKindLabel(node.workspaceKind, t)}
          </span>
          {!active && (
            <button
              type="button"
              aria-label={`${t("task.route.switch")} ${node.routeId}`}
              disabled={switchingTo !== null}
              onClick={() => void switchTo(node.routeId)}
              className="ml-auto h-6 shrink-0 rounded border border-(--color-app-border) px-2 text-[11px] text-(--color-app-muted) hover:bg-(--color-app-bubble) disabled:opacity-50"
            >
              {t("task.route.switch")}
            </button>
          )}
        </div>
        {node.children.length > 0 && <div className="space-y-1">{node.children.map(renderNode)}</div>}
      </div>
    );
  };

  return (
    <section
      aria-label={t("task.route.title")}
      className="rounded-xl border border-(--color-app-hairline) bg-(--color-app-panel)"
    >
      <header className="flex items-center gap-2 border-b border-(--color-app-hairline) px-3 py-2">
        <span className="text-[12.5px] font-semibold">{t("task.route.title")}</span>
        {error && (
          <span role="alert" className="ml-auto max-w-[60%] truncate text-[11px] text-red-600" title={error}>
            {error}
          </span>
        )}
      </header>
      <div className="space-y-1 px-2 py-2">{buildRouteTree(model.routes).map(renderNode)}</div>
    </section>
  );
}
