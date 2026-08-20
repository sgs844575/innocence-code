// @vitest-environment jsdom
// RoutePanel 测试（Task 10）：切换路线必须等 route IPC 带回完整 view model
// 后才更新 UI（无 stale flash），并展示 parent/child、fork turn、checkpoint、
// workspace kind。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutePanel, type RoutePanelModel } from "./RoutePanel";
import { buildRouteTree, type RouteInfo } from "./taskViewModel";

const routes: RouteInfo[] = [
  { routeId: "main", parentRouteId: null, forkTurnId: null, checkpointId: "c0", workspaceKind: "git" },
  { routeId: "child", parentRouteId: "main", forkTurnId: "a2", checkpointId: "c1", workspaceKind: "snapshot" },
];

afterEach(cleanup);

describe("RoutePanel", () => {
  it("displays parent/child structure, fork turn, checkpoint and workspace kind", () => {
    render(
      <RoutePanel
        taskId="t1"
        routes={routes}
        activeRouteId="main"
        switchRoute={vi.fn(async () => ({ routes, activeRouteId: "main" }))}
      />,
    );
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("child")).toBeTruthy();
    expect(screen.getByText("a2")).toBeTruthy(); // fork turn
    expect(screen.getByText("c1")).toBeTruthy(); // checkpoint
    expect(screen.getByText("Git 工作树")).toBeTruthy();
    expect(screen.getByText("快照工作区")).toBeTruthy();
    expect(screen.getByText("当前")).toBeTruthy();
  });

  it("awaits the full view model before updating the active route", async () => {
    let resolveModel!: (model: RoutePanelModel) => void;
    const switchRoute = vi.fn(
      () => new Promise<RoutePanelModel>((done) => { resolveModel = done; }),
    );
    render(
      <RoutePanel taskId="t1" routes={routes} activeRouteId="main" switchRoute={switchRoute} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换路线 child" }));
    expect(switchRoute).toHaveBeenCalledWith({ taskId: "t1", routeId: "child" });
    expect(screen.getByText("切换中")).toBeTruthy();
    // 尚未 resolve：child 仍是可切换的非当前路线（无 stale flash）
    expect(screen.getByRole("button", { name: "切换路线 child" })).toBeTruthy();

    resolveModel({ routes, activeRouteId: "child" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "切换路线 child" })).toBeNull(),
    );
    expect(screen.queryByText("切换中")).toBeNull();
    expect(screen.getByRole("button", { name: "切换路线 main" })).toBeTruthy();
  });

  it("keeps the previous view model and shows the error when switching fails", async () => {
    const switchRoute = vi.fn(async () => { throw new Error("worktree busy"); });
    render(
      <RoutePanel taskId="t1" routes={routes} activeRouteId="main" switchRoute={switchRoute} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换路线 child" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "切换路线 child" })).toBeTruthy();
  });
});

describe("buildRouteTree", () => {
  it("nests children under parents with depth, treating orphans as roots", () => {
    const tree = buildRouteTree([
      ...routes,
      { routeId: "grandchild", parentRouteId: "child", forkTurnId: "a3", checkpointId: "c2", workspaceKind: "git" },
      { routeId: "lost", parentRouteId: "ghost", forkTurnId: null, checkpointId: "c3", workspaceKind: "git" },
    ]);
    expect(tree.map((n) => n.routeId)).toEqual(["main", "lost"]);
    const child = tree.find((n) => n.routeId === "main")!.children[0];
    expect(child.routeId).toBe("child");
    expect(child.depth).toBe(1);
    expect(child.children.map((n) => n.routeId)).toEqual(["grandchild"]);
    expect(child.children[0].depth).toBe(2);
  });
});
