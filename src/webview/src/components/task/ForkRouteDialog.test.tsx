// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForkRouteDialog } from "./ForkRouteDialog";

const request = {
  sessionId: "session-1",
  taskId: "task-1",
  sourceRouteId: "main",
  sourceTurnId: "a2",
  mode: "retry-assistant" as const,
  routeName: "Retry a2",
};

afterEach(cleanup);

describe("ForkRouteDialog", () => {
  it("shows fork target details and switches only after route creation resolves", async () => {
    let resolve!: (route: { routeId: string; parentRouteId: string; checkpointId: string; workspaceRoot: string }) => void;
    const createRoute = vi.fn(() => new Promise<Parameters<typeof resolve>[0]>((done) => { resolve = done; }));
    const onSwitchRoute = vi.fn();
    render(
      <ForkRouteDialog
        open
        request={request}
        checkpointId="c1"
        onClose={() => {}}
        createRoute={createRoute}
        onSwitchRoute={onSwitchRoute}
      />,
    );

    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("c1")).toBeTruthy();
    expect(screen.getByText("隔离 worktree")).toBeTruthy();
    expect(screen.getByText("原路线保持不变")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "创建路线" }));
    expect(onSwitchRoute).not.toHaveBeenCalled();

    resolve({ routeId: "child", parentRouteId: "main", checkpointId: "c1", workspaceRoot: "D:/wt/child" });
    await waitFor(() => expect(onSwitchRoute).toHaveBeenCalledWith("child"));
  });

  it("keeps the current route and displays the error when creation fails", async () => {
    const onSwitchRoute = vi.fn();
    render(
      <ForkRouteDialog
        open
        request={request}
        checkpointId="c1"
        onClose={() => {}}
        createRoute={async () => { throw new Error("worktree unavailable"); }}
        onSwitchRoute={onSwitchRoute}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建路线" }));
    expect((await screen.findByRole("alert")).textContent).toContain("worktree unavailable");
    expect(onSwitchRoute).not.toHaveBeenCalled();
  });
});
