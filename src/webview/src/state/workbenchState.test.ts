// workbenchState — 纯 reducer 测试（Task 12 步骤 1）。状态逻辑不依赖
// React：reduceWorkbenchState 是纯函数，hooks 只做 IPC 订阅 → dispatch 的
// 包装。覆盖任务简报的三条语义：非活动路线事件不应用、restart 告警可见、
// 运行中 route 的事件不被另一个 session 消耗；另覆盖四类恢复/资源失败状态。
import { describe, expect, it } from "vitest";
import {
  completeBlocked,
  createWorkbenchState,
  emptyWorkbenchState,
  initialState,
  reduceWorkbenchState,
  restartWarningVisible,
  shouldLoadTaskAfterRetry,
  taskChanged,
  writeToolsBlocked,
  type TaskUiNotice,
  type WorkbenchTask,
} from "./workbenchState";

const notice = (partial: Partial<TaskUiNotice> & { type: TaskUiNotice["type"] }): TaskUiNotice =>
  ({
    taskId: "task",
    sessionId: "session",
    routeId: "r1",
    ...partial,
  }) as TaskUiNotice;

/** 与 initialState 相同的任务种子（task/loaded 回装用）。 */
function seedTask(): WorkbenchTask {
  return {
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
  };
}

describe("reduceWorkbenchState: task event routing", () => {
  it("does not apply a task event for an inactive route", () => {
    const state = reduceWorkbenchState(initialState, taskChanged({ routeId: "r2" }));
    expect(state.activeRouteId).toBe("r1");
    expect(state.pendingForeignEvents).toHaveLength(1);
  });

  it("does not consume a running route's events from another session", () => {
    const state = reduceWorkbenchState(
      initialState,
      taskChanged({ routeId: "r1", sessionId: "session_other" }),
    );
    expect(state.activeRouteId).toBe("r1");
    expect(state.task?.status).toBe("running");
    expect(state.pendingForeignEvents).toHaveLength(1);
    expect(state.pendingForeignEvents[0]).toMatchObject({ sessionId: "session_other", routeId: "r1" });
  });

  it("applies an event for the active route and session", () => {
    const state = reduceWorkbenchState(initialState, taskChanged({ routeId: "r1", status: "review" }));
    expect(state.task?.status).toBe("review");
    expect(state.pendingForeignEvents).toHaveLength(0);
  });

  it("routeAttached switches the active route (matching task-core semantics)", () => {
    const state = reduceWorkbenchState(
      initialState,
      taskChanged({
        routeId: "r2",
        kind: "routeAttached",
        route: {
          routeId: "r2",
          parentRouteId: "r1",
          forkTurnId: "turn_1",
          checkpointId: "ckpt_2",
          workspaceKind: "git",
        },
      }),
    );
    expect(state.activeRouteId).toBe("r2");
    expect(state.task?.routes.map((r) => r.routeId)).toEqual(["r1", "r2"]);
    expect(state.task?.routes[1]).toMatchObject({ forkTurnId: "turn_1", workspaceKind: "git" });
  });
});

describe("reduceWorkbenchState: restart warning", () => {
  it("shows the restart warning after restart recovery", () => {
    const state = reduceWorkbenchState(
      initialState,
      { type: "task/notice", notice: notice({ type: "restartRecovered", warnings: ["turn t prepared"] }) },
    );
    expect(restartWarningVisible(state)).toBe(true);
  });

  it("dismisses the restart warning", () => {
    const warned = reduceWorkbenchState(
      initialState,
      { type: "task/notice", notice: notice({ type: "restartRecovered", warnings: ["turn t prepared"] }) },
    );
    expect(restartWarningVisible(warned)).toBe(true);
    expect(restartWarningVisible(reduceWorkbenchState(warned, { type: "recovery/dismissRestart" }))).toBe(false);
  });
});

describe("reduceWorkbenchState: error and recovery states", () => {
  it("blocks write tools when task event recovery fails", () => {
    const state = reduceWorkbenchState(
      initialState,
      {
        type: "task/notice",
        notice: notice({ type: "eventRecoveryFailed", message: "log corrupt" }),
      },
    );
    expect(writeToolsBlocked(state)).toBe(true);
    expect(restartWarningVisible(state)).toBe(true);
  });

  it("retains the worktree failure with its retry command and no baseline fallback", () => {
    const retry = { taskId: "task", sessionId: "session", routeId: "r1", mode: "isolated" as const };
    const state = reduceWorkbenchState(
      initialState,
      {
        type: "task/notice",
        notice: notice({ type: "worktreeFailed", message: "createWorktree failed", retry }),
      },
    );
    expect(state.recovery.worktreeFailure).toEqual({ message: "createWorktree failed", retry });
    expect(writeToolsBlocked(state)).toBe(true);
    expect(state.task?.mode).toBe("isolated");
  });

  it("marks checkpoint-failed and blocks completion", () => {
    const state = reduceWorkbenchState(
      initialState,
      taskChanged({ routeId: "r1", kind: "taskStatus", status: "checkpoint-failed" }),
    );
    expect(state.task?.status).toBe("checkpoint-failed");
    expect(completeBlocked(state)).toBe(true);
  });

  it("shows checkpoint-failed as a visible warning via its notice", () => {
    const state = reduceWorkbenchState(
      initialState,
      { type: "task/notice", notice: notice({ type: "checkpointFailed", message: "write failed" }) },
    );
    expect(state.recovery.checkpointFailed).toBe("write failed");
    expect(completeBlocked(state)).toBe(true);
    expect(restartWarningVisible(state)).toBe(true);
  });

  it("recovers from a transcript/checkpoint inconsistency at the last complete event", () => {
    const state = reduceWorkbenchState(
      initialState,
      {
        type: "task/notice",
        notice: notice({
          type: "inconsistencyRecovered",
          message: "truncated tail",
          recoveredFromEventId: "evt_7",
        }),
      },
    );
    expect(state.recovery.recoveredFromInconsistent).toBe("truncated tail");
    expect(state.task?.expectedVersion).toBe("evt_7");
    expect(restartWarningVisible(state)).toBe(true);
  });
});

describe("reduceWorkbenchState: session-scoped recovery notices (review fix)", () => {
  it("ignores a foreign-session notice when no task is loaded (no app-wide send block)", () => {
    // Landing state (no session, no task): startup notices of OLD tasks must
    // not leak in — writeToolsBlocked would reject every send app-wide.
    let state = reduceWorkbenchState(emptyWorkbenchState, {
      type: "task/notice",
      notice: notice({ type: "eventRecoveryFailed", sessionId: "session_old", message: "corrupt" }),
    });
    expect(writeToolsBlocked(state)).toBe(false);
    expect(restartWarningVisible(state)).toBe(false);

    // Active session but still no task loaded: a foreign session's notice is
    // equally ignored.
    const withSession = reduceWorkbenchState(emptyWorkbenchState, {
      type: "session/switched",
      sessionId: "session",
    });
    state = reduceWorkbenchState(withSession, {
      type: "task/notice",
      notice: notice({
        type: "worktreeFailed",
        sessionId: "session_other",
        message: "boom",
        retry: { taskId: "task_old", sessionId: "session_other", routeId: "r1", mode: "isolated" },
      }),
    });
    expect(writeToolsBlocked(state)).toBe(false);
    expect(state.recovery.worktreeFailure).toBeNull();
    expect(restartWarningVisible(state)).toBe(false);
  });

  it("consumes a notice that belongs to the active session even without a loaded task", () => {
    const withSession = reduceWorkbenchState(emptyWorkbenchState, {
      type: "session/switched",
      sessionId: "session",
    });
    const state = reduceWorkbenchState(withSession, {
      type: "task/notice",
      notice: notice({ type: "checkpointFailed", message: "write failed" }),
    });
    expect(completeBlocked(state)).toBe(true);
    expect(restartWarningVisible(state)).toBe(true);
  });

  it("a zero-warning restartRecovered does not clear another failure's warning", () => {
    const warned = reduceWorkbenchState(initialState, {
      type: "task/notice",
      notice: notice({ type: "eventRecoveryFailed", message: "corrupt" }),
    });
    expect(restartWarningVisible(warned)).toBe(true);
    const after = reduceWorkbenchState(warned, {
      type: "task/notice",
      notice: notice({ type: "restartRecovered", warnings: [] }),
    });
    expect(restartWarningVisible(after)).toBe(true);
  });

  it("a foreign restartRecovered cannot clear an existing warning", () => {
    const warned = reduceWorkbenchState(initialState, {
      type: "task/notice",
      notice: notice({ type: "eventRecoveryFailed", message: "corrupt" }),
    });
    const after = reduceWorkbenchState(warned, {
      type: "task/notice",
      notice: notice({ type: "restartRecovered", sessionId: "session_other", warnings: [] }),
    });
    expect(restartWarningVisible(after)).toBe(true);
  });

  it("only loads the retried task when it is the active context (retry guard)", () => {
    expect(shouldLoadTaskAfterRetry(initialState, "task")).toBe(true);
    expect(shouldLoadTaskAfterRetry(initialState, "task_foreign")).toBe(false);
    expect(shouldLoadTaskAfterRetry({ ...emptyWorkbenchState, sessionId: "session" }, "task")).toBe(true);
  });

  it("a successful reload clears disproven recovery failures and their gate", () => {
    const failed = reduceWorkbenchState(initialState, {
      type: "task/notice",
      notice: notice({
        type: "worktreeFailed",
        message: "boom",
        retry: { taskId: "task", sessionId: "session", routeId: "r1", mode: "isolated" },
      }),
    });
    expect(writeToolsBlocked(failed)).toBe(true);
    const reloaded = reduceWorkbenchState(failed, {
      type: "task/loaded",
      task: seedTask(),
      activeRouteId: "r1",
    });
    expect(reloaded.recovery.worktreeFailure).toBeNull();
    expect(writeToolsBlocked(reloaded)).toBe(false);
  });
});

describe("reduceWorkbenchState: session and route switching", () => {
  it("clears the task context when another session becomes active", () => {
    const state = reduceWorkbenchState(initialState, { type: "session/switched", sessionId: "session_other" });
    expect(state.task).toBeNull();
    expect(state.activeRouteId).toBe("");
    expect(state.sessionId).toBe("session_other");
  });

  it("keeps the task context when its own session stays active", () => {
    const state = reduceWorkbenchState(initialState, { type: "session/switched", sessionId: "session" });
    expect(state.task?.taskId).toBe("task");
  });

  it("replaces the route model after a successful route switch", () => {
    const state = reduceWorkbenchState(initialState, {
      type: "task/routeSwitched",
      routes: [
        { routeId: "r1", parentRouteId: null, forkTurnId: null, checkpointId: "c1", workspaceKind: "git" },
        { routeId: "r2", parentRouteId: "r1", forkTurnId: "t", checkpointId: "c2", workspaceKind: "git" },
      ],
      activeRouteId: "r2",
    });
    expect(state.activeRouteId).toBe("r2");
    expect(state.task?.routes).toHaveLength(2);
  });
});

describe("createWorkbenchState", () => {
  it("seeds task identity, routes and active route", () => {
    const state = createWorkbenchState({
      task: {
        taskId: "t9",
        sessionId: "s9",
        status: "ready",
        mode: "baseline",
        workspaceKind: "git",
        gitBranch: "main",
        routes: [
          { routeId: "main", parentRouteId: null, forkTurnId: null, checkpointId: "c", workspaceKind: "git" },
        ],
        expectedVersion: "evt_1",
      },
    });
    expect(state.task?.gitBranch).toBe("main");
    expect(state.activeRouteId).toBe("main");
    expect(writeToolsBlocked(state)).toBe(false);
  });
});
