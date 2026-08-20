// workbenchState — 工作台任务上下文的纯 reducer（Task 12）。
//
// useWorkbenchState 的核心：任务/路线/审查/冲突/恢复状态全部在这里以纯函数
// 折叠，hooks 只做 IPC 订阅 → dispatch 的包装（无需 React 渲染即可测试）。
//
// 事件路由纪律（任务简报）：
//   - 非活动路线的 task event 不应用：进 pendingForeignEvents（保留待
//     route 切回后由 main 的完整 view model 对账）。
//   - 另一个 session 的事件不被本 session 消耗：同样进 foreign 队列。
//   - routeAttached 是唯一会切换 activeRouteId 的事件种类（与 task-core
//     reducer 的语义一致：fork 挂接即接管会话的当前路线）。
//
// 恢复/失败状态（每条 = 可见告警 + 门禁）：
//   - eventRecoveryFailed  → writeToolsBlocked（禁止写工具/新回合）
//   - worktreeFailed       → 错误 + 重试命令保留；绝不降级 baseline
//   - checkpointFailed     → checkpoint-failed 展示；completeBlocked
//   - inconsistencyRecovered → 从最后完整事件恢复并提示
import type {
  ConflictDetail,
  TaskUiEvent,
  TaskUiNotice,
  TaskWorktreeRetry,
} from "../../../shared/taskIpc";
import type { RouteInfo } from "../components/task/taskViewModel";

// 渲染层消费的推送 DTO 类型别名（shared/taskIpc 是唯一契约源）。
export type { TaskUiEvent, TaskUiNotice, TaskWorktreeRetry };

/** Foreign 队列上限：越界丢最旧（无界面消费时的防泄漏护栏）。 */
export const MAX_PENDING_FOREIGN_EVENTS = 100;

/** 任务上下文（TaskGetResponse + 路线 view model 的合并视图）。 */
export interface WorkbenchTask {
  taskId: string;
  sessionId: string;
  status: string;
  mode: string;
  workspaceKind: string;
  /** 真实分支（main 检测）；null = 未知（TitleBar chip 隐藏）。 */
  gitBranch: string | null;
  routes: RouteInfo[];
  expectedVersion: string;
}

export interface WorkbenchWorktreeFailure {
  message: string;
  retry: TaskWorktreeRetry;
}

export interface WorkbenchRecoveryState {
  /** task event 回放失败 → 可见告警 + 写工具门禁。 */
  eventRecoveryFailed: string | null;
  /** worktree 创建/恢复失败 → 错误 + 重试命令保留（不降级 baseline）。 */
  worktreeFailure: WorkbenchWorktreeFailure | null;
  /** checkpoint 写失败 → checkpoint-failed + 完成门禁。 */
  checkpointFailed: string | null;
  /** transcript/task checkpoint 不一致 → 已从最后完整事件恢复。 */
  recoveredFromInconsistent: string | null;
}

export interface PendingForeignEvent {
  taskId: string;
  sessionId: string;
  routeId: string;
  kind: TaskUiEvent["kind"];
}

export interface WorkbenchState {
  /** null = 当前会话没有任务上下文（落地态/纯聊天）。 */
  task: WorkbenchTask | null;
  /** 活动路线 id；无任务时为 ""。 */
  activeRouteId: string;
  /** 非活动路线/外部会话/外部任务的未消费事件（观察用）。 */
  pendingForeignEvents: readonly PendingForeignEvent[];
  /** 重启恢复告警可见（用户可关闭）。 */
  restartWarning: boolean;
  /** apply 冲突明细（task:apply 返回 conflict 时进入，裁决后清空）。 */
  conflicts: readonly ConflictDetail[];
  recovery: WorkbenchRecoveryState;
}

export type WorkbenchAction =
  | { type: "task/loaded"; task: WorkbenchTask; activeRouteId: string }
  | { type: "task/event"; event: TaskUiEvent }
  | { type: "task/notice"; notice: TaskUiNotice }
  | { type: "task/routeSwitched"; routes: RouteInfo[]; activeRouteId: string; version?: string }
  | { type: "task/conflictsDetected"; conflicts: ConflictDetail[] }
  | { type: "task/conflictsResolved" }
  | { type: "session/switched"; sessionId: string | null }
  | { type: "recovery/dismissRestart" };

/** 未附着任务时的空状态（hook 的初始值）。 */
export const emptyWorkbenchState: WorkbenchState = {
  task: null,
  activeRouteId: "",
  pendingForeignEvents: [],
  restartWarning: false,
  conflicts: [],
  recovery: {
    eventRecoveryFailed: null,
    worktreeFailure: null,
    checkpointFailed: null,
    recoveredFromInconsistent: null,
  },
};

export function createWorkbenchState(seed: { task: WorkbenchTask; activeRouteId?: string }): WorkbenchState {
  return {
    ...emptyWorkbenchState,
    recovery: emptyRecovery(),
    task: seed.task,
    activeRouteId: seed.activeRouteId ?? seed.task.routes[0]?.routeId ?? "",
  };
}

/** Fresh recovery slice（不复用共享引用，重置后互不影响）。 */
function emptyRecovery(): WorkbenchRecoveryState {
  return {
    eventRecoveryFailed: null,
    worktreeFailure: null,
    checkpointFailed: null,
    recoveredFromInconsistent: null,
  };
}

/** 丢弃最旧的 foreign 事件，保持队列有界。 */
function park(state: WorkbenchState, event: TaskUiEvent): WorkbenchState {
  const foreign: PendingForeignEvent = {
    taskId: event.taskId,
    sessionId: event.sessionId,
    routeId: event.routeId,
    kind: event.kind,
  };
  const next = [...state.pendingForeignEvents, foreign];
  return { ...state, pendingForeignEvents: next.slice(Math.max(0, next.length - MAX_PENDING_FOREIGN_EVENTS)) };
}

function applyTaskEvent(task: WorkbenchTask, event: TaskUiEvent): WorkbenchTask {
  let next: WorkbenchTask = {
    ...task,
    expectedVersion: event.version ?? task.expectedVersion,
  };
  if (event.kind === "taskStatus" && typeof event.status === "string") {
    next = { ...next, status: event.status };
  } else if (event.kind === "routeAttached" && event.route) {
    const route: RouteInfo = {
      routeId: event.route.routeId,
      parentRouteId: event.route.parentRouteId,
      forkTurnId: event.route.forkTurnId,
      checkpointId: event.route.checkpointId,
      workspaceKind: event.route.workspaceKind,
    };
    const routes = task.routes.some((existing) => existing.routeId === route.routeId)
      ? task.routes.map((existing) => (existing.routeId === route.routeId ? route : existing))
      : [...task.routes, route];
    next = { ...next, routes };
  }
  return next;
}

function applyNotice(state: WorkbenchState, notice: TaskUiNotice): WorkbenchState {
  const task = state.task;
  if (task && (notice.taskId !== task.taskId || notice.sessionId !== task.sessionId)) {
    return state; // 别的任务/会话的恢复通知：不消耗
  }
  const recovery = { ...state.recovery };
  let restartWarning = state.restartWarning;
  let nextTask = task;
  switch (notice.type) {
    case "eventRecoveryFailed":
      recovery.eventRecoveryFailed = notice.message;
      restartWarning = true;
      break;
    case "worktreeFailed":
      recovery.worktreeFailure = { message: notice.message, retry: notice.retry };
      restartWarning = true;
      break;
    case "checkpointFailed":
      recovery.checkpointFailed = notice.message;
      if (nextTask) nextTask = { ...nextTask, status: "checkpoint-failed" };
      restartWarning = true;
      break;
    case "inconsistencyRecovered":
      recovery.recoveredFromInconsistent = notice.message;
      restartWarning = true;
      if (nextTask) nextTask = { ...nextTask, expectedVersion: notice.recoveredFromEventId };
      break;
    case "restartRecovered":
      restartWarning = notice.warnings.length > 0;
      break;
  }
  return { ...state, task: nextTask, recovery, restartWarning };
}

export function reduceWorkbenchState(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  switch (action.type) {
    case "task/loaded":
      return { ...state, task: action.task, activeRouteId: action.activeRouteId, pendingForeignEvents: [] };
    case "task/event": {
      const task = state.task;
      if (!task) return park(state, action.event);
      if (action.event.taskId !== task.taskId) return park(state, action.event);
      if (action.event.sessionId !== task.sessionId) return park(state, action.event);
      // routeAttached 切换活动路线；其余种类只作用于活动路线。
      const activatesRoute = action.event.kind === "routeAttached";
      if (!activatesRoute && action.event.routeId !== state.activeRouteId) {
        return park(state, action.event);
      }
      const nextTask = applyTaskEvent(task, action.event);
      const nextActive = activatesRoute && action.event.route
        ? action.event.route.routeId
        : state.activeRouteId;
      return { ...state, task: nextTask, activeRouteId: nextActive };
    }
    case "task/notice":
      return applyNotice(state, action.notice);
    case "task/routeSwitched":
      return {
        ...state,
        activeRouteId: action.activeRouteId,
        task: state.task
          ? {
              ...state.task,
              routes: action.routes,
              expectedVersion: action.version ?? state.task.expectedVersion,
            }
          : null,
      };
    case "task/conflictsDetected":
      return { ...state, conflicts: action.conflicts };
    case "task/conflictsResolved":
      return { ...state, conflicts: [] };
    case "session/switched": {
      const task = state.task;
      if (task && action.sessionId !== null && task.sessionId === action.sessionId) return state;
      return { ...emptyWorkbenchState, recovery: emptyRecovery(), pendingForeignEvents: [] };
    }
    case "recovery/dismissRestart":
      return { ...state, restartWarning: false };
  }
}

// ---------------------------------------------------------------------------
// Action creators
// ---------------------------------------------------------------------------

export interface TaskChangedInput {
  taskId?: string;
  sessionId?: string;
  routeId: string;
  kind?: TaskUiEvent["kind"];
  status?: string;
  version?: string;
  route?: TaskUiEvent["route"];
}

/** task/event 动作构造器（简报测试片段的入口）。 */
export function taskChanged(input: TaskChangedInput): WorkbenchAction {
  return {
    type: "task/event",
    event: {
      taskId: input.taskId ?? "task",
      sessionId: input.sessionId ?? "session",
      routeId: input.routeId,
      kind: input.kind ?? "taskStatus",
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(input.route !== undefined ? { route: input.route } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Selectors（派生门禁 —— 不在 state 里二次记账）
// ---------------------------------------------------------------------------

/** 恢复未解决（事件回放失败 / worktree 失败）→ 禁止写工具与新回合。 */
export function writeToolsBlocked(state: WorkbenchState): boolean {
  return state.recovery.eventRecoveryFailed !== null || state.recovery.worktreeFailure !== null;
}

/** checkpoint 写失败 → 禁止 complete。 */
export function completeBlocked(state: WorkbenchState): boolean {
  return state.recovery.checkpointFailed !== null || state.task?.status === "checkpoint-failed";
}

/** restart/恢复告警可见。 */
export function restartWarningVisible(state: WorkbenchState): boolean {
  return state.restartWarning;
}

// ---------------------------------------------------------------------------
// 简报测试的规范初始状态：session 上挂着一个 running 任务，活动路线 r1。
// ---------------------------------------------------------------------------

export const initialState: WorkbenchState = createWorkbenchState({
  task: {
    taskId: "task",
    sessionId: "session",
    status: "running",
    mode: "isolated",
    workspaceKind: "git",
    gitBranch: null,
    routes: [
      { routeId: "r1", parentRouteId: null, forkTurnId: null, checkpointId: "ckpt_r1", workspaceKind: "git" },
    ],
    expectedVersion: "evt_0",
  },
});
