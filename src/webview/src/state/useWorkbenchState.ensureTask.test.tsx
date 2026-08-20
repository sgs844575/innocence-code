// @vitest-environment jsdom
// C1 (final review): the task:start channel populates the workbench. The
// hook's ensureTask calls taskApi.start and installs the returned task
// through loadTask (getTask + listRoutes) — session activation probes with
// create:false, the first send creates with create:true.
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const taskApiMock = vi.hoisted(() => ({
  start: vi.fn<(request: unknown) => Promise<unknown>>(),
  getTask: vi.fn<(request: unknown) => Promise<unknown>>(),
  listRoutes: vi.fn<(request: unknown) => Promise<unknown>>(),
  onTaskEvent: vi.fn<() => () => void>(() => () => {}),
  onTaskNotice: vi.fn<() => () => void>(() => () => {}),
}));

vi.mock("../lib/ipc", () => ({ taskApi: taskApiMock }));

import { useWorkbenchState } from "./useWorkbenchState";

const taskView = {
  taskId: "t1",
  sessionId: "s1",
  status: "ready",
  activeRouteId: "main",
  mode: "baseline",
  workspaceKind: "git",
  version: "evt_1",
  gitBranch: null,
  routeId: "main",
};

const routes = {
  routes: [
    { routeId: "main", parentRouteId: null, forkTurnId: null, checkpointId: "ckpt_1", workspaceKind: "git" },
  ],
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("useWorkbenchState.ensureTask (C1)", () => {
  it("installs the started task through loadTask (getTask + listRoutes)", async () => {
    taskApiMock.start.mockResolvedValue(taskView);
    taskApiMock.getTask.mockResolvedValue(taskView);
    taskApiMock.listRoutes.mockResolvedValue(routes);

    const { result } = renderHook(() => useWorkbenchState({ sessionId: "s1" }));
    expect(result.current.state.task).toBeNull();

    await act(async () => {
      await result.current.ensureTask("s1");
    });

    expect(taskApiMock.start).toHaveBeenCalledWith({ sessionId: "s1", create: true });
    expect(taskApiMock.getTask).toHaveBeenCalledWith({ taskId: "t1" });
    expect(taskApiMock.listRoutes).toHaveBeenCalledWith({ taskId: "t1" });
    expect(result.current.state.task).toMatchObject({
      taskId: "t1",
      sessionId: "s1",
      expectedVersion: "evt_1",
      routes: [{ routeId: "main", checkpointId: "ckpt_1" }],
    });
    expect(result.current.state.activeRouteId).toBe("main");
    expect(result.current.activeTask).toEqual({ taskId: "t1", routeId: "main" });

    // Short-circuit: the same session does not re-start.
    await act(async () => {
      await result.current.ensureTask("s1");
    });
    expect(taskApiMock.start).toHaveBeenCalledTimes(1);
  });

  it("create:false probes and leaves the workbench empty when the session has no task", async () => {
    taskApiMock.start.mockResolvedValue(null);

    const { result } = renderHook(() => useWorkbenchState({ sessionId: "s1" }));
    await act(async () => {
      await result.current.ensureTask("s1", false);
    });

    expect(taskApiMock.start).toHaveBeenCalledWith({ sessionId: "s1", create: false });
    expect(result.current.state.task).toBeNull();
    expect(taskApiMock.getTask).not.toHaveBeenCalled();
  });

  it("swallows start failures (the chat still works without a task context)", async () => {
    taskApiMock.start.mockRejectedValue(new Error("no workspace root"));
    const { result } = renderHook(() => useWorkbenchState({ sessionId: "s1" }));
    await act(async () => {
      await result.current.ensureTask("s1");
    });
    expect(result.current.state.task).toBeNull();
  });
});
