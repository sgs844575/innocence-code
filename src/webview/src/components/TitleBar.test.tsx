// @vitest-environment jsdom
// TitleBar 最小覆盖（Task 11 review fold-in）：工作台控件走注入的 t
//（en-US 不再露出中文硬编码）、终端开关带 aria-pressed、gitBranch 未知时
// branch chip 整片隐藏（不渲染错误的「非 Git」）。纯 props 驱动，不触 IPC。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TitleBar } from "./TitleBar";

afterEach(cleanup);

describe("TitleBar workbench controls", () => {
  it("localizes the editor/panel/terminal controls through the injected t", () => {
    render(
      <TitleBar
        sidebarOpen
        onToggleSidebar={() => undefined}
        workbench={{ project: "demo", routeId: null, gitBranch: null }}
        onOpenExternalEditor={() => undefined}
        onTogglePanel={() => undefined}
        onToggleTerminal={() => undefined}
        t={(key) => ({ "titlebar.externalEditor": "Open in editor", "titlebar.togglePanel": "Toggle panel", "titlebar.toggleTerminal": "Toggle terminal" }[key] ?? key)}
      />,
    );
    expect(screen.getByRole("button", { name: "Open in editor" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Toggle panel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Toggle terminal" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "在外部编辑器打开" })).toBeNull();
  });

  it("carries aria-pressed state on the panel and terminal toggles", () => {
    render(
      <TitleBar
        sidebarOpen
        onToggleSidebar={() => undefined}
        panelOpen
        terminalOpen={false}
        onTogglePanel={() => undefined}
        onToggleTerminal={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "切换辅助面板" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "切换终端" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("hides the git branch chip while the branch is unknown (no wrong 非 Git)", () => {
    render(
      <TitleBar
        sidebarOpen
        onToggleSidebar={() => undefined}
        workbench={{ project: "demo", routeId: null, gitBranch: null }}
      />,
    );
    expect(screen.queryByText("非 Git")).toBeNull();
    expect(screen.getByText("demo")).toBeTruthy();
  });

  it("shows the branch chip when a branch is known", () => {
    render(
      <TitleBar
        sidebarOpen
        onToggleSidebar={() => undefined}
        workbench={{ project: "demo", routeId: "route_x", gitBranch: "main" }}
      />,
    );
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("route_x")).toBeTruthy();
  });

  it("disables the external editor entry when no handler is wired", () => {
    render(<TitleBar sidebarOpen onToggleSidebar={() => undefined} />);
    const editor = screen.getByRole("button", { name: "在外部编辑器打开" }) as HTMLButtonElement;
    expect(editor.disabled).toBe(true);
  });
});
