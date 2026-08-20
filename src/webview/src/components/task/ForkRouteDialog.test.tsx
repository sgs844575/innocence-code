// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForkRouteDialog } from "./ForkRouteDialog";

const retryRequest = {
  sessionId: "session-1",
  taskId: "task-1",
  sourceRouteId: "main",
  sourceTurnId: "a2",
  mode: "retry-assistant" as const,
  routeName: "Retry a2",
};

const editRequest = {
  ...retryRequest,
  sourceTurnId: "u2",
  mode: "edit-user" as const,
  editedText: "original prompt",
  routeName: "Edit u2",
};

afterEach(cleanup);

describe("ForkRouteDialog", () => {
  it("shows fork target details and switches only after route creation resolves", async () => {
    let resolve!: (route: { routeId: string; parentRouteId: string; checkpointId: string; workspaceRoot: string; prompt: string }) => void;
    const createRoute = vi.fn(() => new Promise<Parameters<typeof resolve>[0]>((done) => { resolve = done; }));
    const onSwitchRoute = vi.fn();
    render(
      <ForkRouteDialog
        open
        request={retryRequest}
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

    resolve({ routeId: "child", parentRouteId: "main", checkpointId: "c1", workspaceRoot: "D:/wt/child", prompt: "original prompt" });
    await waitFor(() => expect(onSwitchRoute).toHaveBeenCalledWith("child", "original prompt"));
  });

  it("renders editable text in edit-user mode and submits the edited value", async () => {
    const createRoute = vi.fn(async () => ({
      routeId: "child",
      parentRouteId: "main",
      checkpointId: "c1",
      workspaceRoot: "D:/wt/child",
      prompt: "revised prompt",
    }));
    const onSwitchRoute = vi.fn();
    render(
      <ForkRouteDialog
        open
        request={editRequest}
        checkpointId="c1"
        onClose={() => {}}
        createRoute={createRoute}
        onSwitchRoute={onSwitchRoute}
      />,
    );

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("original prompt");
    fireEvent.change(textarea, { target: { value: "revised prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "创建路线" }));

    await waitFor(() => expect(onSwitchRoute).toHaveBeenCalled());
    expect(createRoute).toHaveBeenCalledWith(expect.objectContaining({ editedText: "revised prompt" }));
    expect(onSwitchRoute).toHaveBeenCalledWith("child", "revised prompt");
  });

  it("keeps the current route and displays the error when creation fails", async () => {
    const onSwitchRoute = vi.fn();
    render(
      <ForkRouteDialog
        open
        request={retryRequest}
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
