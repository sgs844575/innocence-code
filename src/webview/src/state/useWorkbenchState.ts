// useWorkbenchState — 任务/路线/审查/冲突/恢复状态钩子（Task 12）。
// 核心是纯 reducer（workbenchState.ts，纯函数测试覆盖）；本钩子只负责
// IPC 订阅 → dispatch 与带真实数据的命令（switchRoute 等 resolve 完整
// view model 后才更新 UI，避免旧内容闪回）。
import { useCallback, useEffect, useReducer } from "react";
import type {
  TaskRestoreRequest,
  TaskReviewDto,
  TaskSwitchRouteRequest,
} from "../../../shared/taskIpc";
import { taskApi } from "../lib/ipc";
import type { RoutePanelModel } from "../components/task/RoutePanel";
import {
  emptyWorkbenchState,
  reduceWorkbenchState,
  type WorkbenchState,
} from "./workbenchState";

export interface WorkbenchStateController {
  state: WorkbenchState;
  /** 活动任务路线（TerminalPanel 的 activeTask；无任务为 null）。 */
  activeTask: { taskId: string; routeId: string } | null;
  /** 路线切换：main 带回完整 view model 后才 dispatch（无 stale flash）。 */
  switchRoute: (request: TaskSwitchRouteRequest) => Promise<RoutePanelModel>;
  /** worktree/回放失败后的重试入口（task:recover → bridge.recoverTask）。 */
  retryRecovery: (taskId: string) => Promise<boolean>;
  /** 拉取任务全量视图（getTask + listRoutes，真实 forkTurnId/workspaceKind）。 */
  loadTask: (taskId: string) => Promise<void>;
  dismissRestartWarning: () => void;
  review: (dto: TaskReviewDto) => Promise<void>;
  restore: (request: TaskRestoreRequest) => Promise<void>;
}

/** TaskRouteSummary → RouteInfo：DTO 已携带真实 forkTurnId/workspaceKind。 */
export function toRouteInfoList(
  routes: readonly {
    routeId: string;
    parentRouteId: string | null;
    forkTurnId: string | null;
    checkpointId: string;
    workspaceKind: string;
  }[],
) {
  return routes.map((route) => ({
    routeId: route.routeId,
    parentRouteId: route.parentRouteId,
    forkTurnId: route.forkTurnId,
    checkpointId: route.checkpointId,
    workspaceKind: route.workspaceKind,
  }));
}

export function useWorkbenchState(deps: { sessionId: string | null }): WorkbenchStateController {
  const { sessionId } = deps;
  const [state, dispatch] = useReducer(reduceWorkbenchState, emptyWorkbenchState);

  // 会话切换：本会话之外的任务上下文整体清空（reducer 判定归属）。
  useEffect(() => {
    dispatch({ type: "session/switched", sessionId });
  }, [sessionId]);

  // 任务事件推送 → reducer（非活动路线/外部会话在 reducer 内 park）。
  useEffect(() => {
    const offEvent = taskApi.onTaskEvent((event) => dispatch({ type: "task/event", event }));
    const offNotice = taskApi.onTaskNotice((notice) => dispatch({ type: "task/notice", notice }));
    return () => {
      offEvent();
      offNotice();
    };
  }, []);

  const loadTask = useCallback(async (taskId: string) => {
    const [task, routes] = await Promise.all([
      taskApi.getTask({ taskId }),
      taskApi.listRoutes({ taskId }),
    ]);
    dispatch({
      type: "task/loaded",
      activeRouteId: task.activeRouteId,
      task: {
        taskId: task.taskId,
        // 会话归属：TaskGetResponse 携带真实 sessionId（单任务单会话）。
        sessionId: task.sessionId,
        status: task.status,
        mode: task.mode,
        workspaceKind: task.workspaceKind,
        gitBranch: task.gitBranch ?? null,
        routes: toRouteInfoList(routes.routes),
        expectedVersion: task.version ?? "",
      },
    });
  }, []);

  const switchRoute = useCallback(
    async (request: TaskSwitchRouteRequest): Promise<RoutePanelModel> => {
      await taskApi.switchRoute(request);
      const { routes } = await taskApi.listRoutes({ taskId: request.taskId });
      const model: RoutePanelModel = {
        routes: toRouteInfoList(routes),
        activeRouteId: request.routeId,
      };
      dispatch({
        type: "task/routeSwitched",
        routes: model.routes,
        activeRouteId: model.activeRouteId,
      });
      return model;
    },
    [],
  );

  const retryRecovery = useCallback(async (taskId: string) => {
    try {
      await taskApi.recoverTask({ taskId });
      await loadTask(taskId);
      return true;
    } catch (cause) {
      console.error("task recovery retry failed", cause);
      return false;
    }
  }, [loadTask]);

  const dismissRestartWarning = useCallback(() => dispatch({ type: "recovery/dismissRestart" }), []);

  const review = useCallback(async (dto: TaskReviewDto) => {
    await taskApi.review(dto);
  }, []);

  const restore = useCallback(async (request: TaskRestoreRequest) => {
    await taskApi.restore(request);
  }, []);

  const activeTask = state.task ? { taskId: state.task.taskId, routeId: state.activeRouteId } : null;

  return {
    state,
    activeTask,
    switchRoute,
    retryRecovery,
    loadTask,
    dismissRestartWarning,
    review,
    restore,
  };
}
