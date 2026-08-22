// @vitest-environment jsdom
// Task 11 渲染侧测试：CodePanel（文件树 view model 渲染 / 只读内容 / 语言徽标 /
// 搜索 / 外部编辑器）与 WorkbenchShell（overlay / docked / tabs 三种响应式
// 形态、ResizeHandle、互斥 tab）。数据全部来自注入的 fake api —— 组件不直接
// 触碰 IPC。brief 的文件清单只列出本文件，因此 WorkbenchShell 的布局断言也
// 放在这里（步骤 2 的四个 RED 文件之一）。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeFileContent, CodeIpcApi, CodeSearchResponse } from "../../../../shared/codeIpc";
import { CodePanel } from "./CodePanel";
import { buildFileTree } from "./codeViewModel";
import { WorkbenchShell } from "../workbench/WorkbenchShell";
import { BuiltinPanels } from "../workbench/builtinPanels";
import { SlotProvider } from "../../slots/react";

// jest-dom 子集：brief 原文断言用 toBeVisible/toBeEnabled/toHaveAttribute；
// 项目未引入 @testing-library/jest-dom，这里补这三个匹配器的最小语义
//（jsdom 无布局，与 ReviewPanel.test.tsx 同一模式）。
declare module "vitest" {
  interface Assertion<T = any> {
    toBeVisible(): void;
    toBeEnabled(): void;
    toHaveAttribute(name: string, value?: string): void;
  }
}
expect.extend({
  toBeVisible(received: unknown) {
    const el = received instanceof HTMLElement ? received : null;
    const pass = el !== null && el.isConnected && !el.hidden && el.style.display !== "none" && el.style.visibility !== "hidden";
    return { pass, message: () => `expected element to be ${pass ? "not " : ""}visible` };
  },
  toBeEnabled(received: unknown) {
    const el = received instanceof HTMLButtonElement ? received : null;
    const pass = el !== null && !el.disabled;
    return { pass, message: () => `expected button to be ${pass ? "disabled" : "enabled"}` };
  },
  toHaveAttribute(received: unknown, name: string, value?: string) {
    const el = received instanceof HTMLElement ? received : null;
    const attr = el?.getAttribute(name) ?? null;
    const pass = value === undefined ? attr !== null : attr === value;
    return {
      pass,
      message: () => `expected element to ${pass ? "not " : ""}have attribute ${name}${value === undefined ? "" : `=${JSON.stringify(value)}`} (got ${JSON.stringify(attr)})`,
    };
  },
});

const textFile = (relativePath: string, language = "typescript"): CodeFileContent => ({
  path: relativePath,
  content: "const x = 1;\n",
  language,
  readOnly: true,
  binary: false,
  truncated: false,
  size: 14,
});

const binaryFile: CodeFileContent = {
  path: "assets/logo.bin",
  content: "",
  language: "binary",
  readOnly: true,
  binary: true,
  truncated: false,
  size: 4096,
};

function makeApi(overrides?: { search?: CodeSearchResponse }) {
  return {
    readFile: vi.fn(async ({ relativePath }: { relativePath: string }) =>
      relativePath.endsWith(".bin") ? binaryFile : textFile(relativePath),
    ),
    listFiles: vi.fn(async () => ({ files: [] })),
    search: vi.fn(
      async () =>
        overrides?.search ?? {
          matches: [{ path: "src/a.ts", line: 12, column: 5, preview: "const needle = 1;" }],
        },
    ),
    openExternalEditor: vi.fn(async () => ({ launched: true })),
  } satisfies CodeIpcApi;
}

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

/** 槽位环境接线：WorkbenchTabs 的页签清单自 1c 起经槽位派生，渲染
 * WorkbenchShell 需包 Provider + 内置面板贡献（断言语义不变）。 */
function mountShell(shell: React.ReactElement): ReturnType<typeof render> {
  return render(
    <SlotProvider>
      <BuiltinPanels panels={{}} />
      {shell}
    </SlotProvider>,
  );
}

describe("CodePanel", () => {
  it("renders the file tree from the view model", () => {
    render(<CodePanel taskId="t1" routeId="r1" api={makeApi()} files={["src/a.ts", "src/deep/b.ts", "README.md"]} />);
    const tree = screen.getByRole("tree", { name: "文件树" });
    expect(tree).toBeVisible();
    expect(screen.getByRole("treeitem", { name: /a\.ts/ })).toBeVisible();
    expect(screen.getByRole("treeitem", { name: /deep/ })).toBeVisible();
    expect(screen.getByRole("treeitem", { name: /README\.md/ })).toBeVisible();
  });

  it("renders read-only content with a language badge after selecting a file", async () => {
    const api = makeApi();
    render(<CodePanel taskId="t1" routeId="r1" api={api} files={["src/a.ts"]} />);
    fireEvent.click(screen.getByRole("treeitem", { name: /a\.ts/ }));
    await waitFor(() => expect(screen.getByText("const x = 1;")).toBeVisible());
    expect(api.readFile).toHaveBeenCalledWith({ taskId: "t1", routeId: "r1", relativePath: "src/a.ts" });
    expect(screen.getByText("typescript")).toBeVisible(); // 语言徽标
    expect(screen.getByText("只读")).toBeVisible();
  });

  it("shows file-level metadata only for binary files", async () => {
    render(<CodePanel taskId="t1" routeId="r1" api={makeApi()} files={["assets/logo.bin"]} />);
    fireEvent.click(screen.getByRole("treeitem", { name: /logo\.bin/ }));
    await waitFor(() => expect(screen.getByText("二进制文件")).toBeVisible());
    expect(screen.queryByText("const x = 1;")).toBeNull();
    expect(screen.getByText(/4\s*KB/)).toBeVisible();
  });

  it("searches through the injected api and jumps to a match", async () => {
    const api = makeApi();
    render(<CodePanel taskId="t1" routeId="r1" api={api} files={["src/a.ts"]} />);
    fireEvent.change(screen.getByLabelText("搜索代码"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(screen.getByText(/src\/a\.ts:12/)).toBeVisible());
    expect(api.search).toHaveBeenCalledWith({ taskId: "t1", routeId: "r1", query: "needle" });
    fireEvent.click(screen.getByRole("button", { name: /跳转到 src\/a\.ts/ }));
    await waitFor(() => expect(api.readFile).toHaveBeenCalledWith({ taskId: "t1", routeId: "r1", relativePath: "src/a.ts" }));
  });

  it("opens the selected file in the external editor", async () => {
    const api = makeApi();
    render(<CodePanel taskId="t1" routeId="r1" api={api} files={["src/a.ts"]} />);
    fireEvent.click(screen.getByRole("treeitem", { name: /a\.ts/ }));
    await waitFor(() => expect(screen.getByText("const x = 1;")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "在外部编辑器打开" }));
    expect(api.openExternalEditor).toHaveBeenCalledWith({
      taskId: "t1",
      routeId: "r1",
      relativePath: "src/a.ts",
      line: undefined,
      column: undefined,
    });
  });
});

describe("codeViewModel", () => {
  it("builds a sorted dir-first tree from relative paths", () => {
    const tree = buildFileTree(["src/deep/b.ts", "README.md", "src/a.ts"]);
    expect(tree.map((n) => n.name)).toEqual(["src", "README.md"]); // 目录在前
    const src = tree.find((n) => n.name === "src")!;
    expect(src.type).toBe("dir");
    expect(src.children.map((n: { name: string }) => n.name)).toEqual(["deep", "a.ts"]);
    expect(src.children[0].children.map((n: { name: string }) => n.name)).toEqual(["b.ts"]);
  });
});

describe("WorkbenchShell responsive modes", () => {
  it("uses an overlay panel below the wide breakpoint", () => {
    mountShell(<WorkbenchShell viewportWidth={720} />);
    expect(screen.getByRole("dialog", { name: "辅助面板" })).toHaveAttribute("data-mode", "overlay");
  });

  it("docks a resizable right panel at the wide breakpoint", () => {
    const { rerender } = mountShell(
      <WorkbenchShell viewportWidth={1280} open activeTab="review">
        <div>chat-main</div>
      </WorkbenchShell>,
    );
    const panel = screen.getByRole("dialog", { name: "辅助面板" });
    expect(panel).toHaveAttribute("data-mode", "docked");
    expect(screen.getByText("chat-main")).toBeVisible(); // 主列仍在文档流
    expect(screen.getByRole("separator", { name: "调整面板宽度" })).toBeVisible();

    // Pointer 拖拽：向左拖 200px → 面板加宽（360 → 560）。
    const handle = screen.getByRole("separator", { name: "调整面板宽度" });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 900 });
    fireEvent.pointerMove(document.body, { pointerId: 1, clientX: 700 });
    fireEvent.pointerUp(document.body, { pointerId: 1 });
    expect(panel.style.width).toBe("560px");

    // 再向左拖出上限 → 夹在 720px。
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 700 });
    fireEvent.pointerMove(document.body, { pointerId: 2, clientX: -5000 });
    fireEvent.pointerUp(document.body, { pointerId: 2 });
    expect(panel.style.width).toBe("720px");
    rerender(
      <SlotProvider>
        <BuiltinPanels panels={{}} />
        <WorkbenchShell viewportWidth={1280} open activeTab="review">
          <div>chat-main</div>
        </WorkbenchShell>
      </SlotProvider>,
    );
    expect(screen.getByRole("dialog", { name: "辅助面板" }).style.width).toBe("720px");
  });

  it("switches panel content through the workbench tabs", () => {
    mountShell(
      <WorkbenchShell
        viewportWidth={1280}
        open
        panels={{
          review: <div>review-content</div>,
          code: <div>code-content</div>,
        }}
      >
        <div>chat-main</div>
      </WorkbenchShell>,
    );
    expect(screen.getByText("review-content")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "代码" }));
    expect(screen.getByText("code-content")).toBeVisible();
    expect(screen.queryByText("review-content")).toBeNull();
  });

  it("makes the panel and the main view mutually exclusive below the narrow breakpoint", () => {
    mountShell(
      <WorkbenchShell viewportWidth={480} open panels={{ terminal: <div>terminal-content</div> }}>
        <div>chat-main</div>
      </WorkbenchShell>,
    );
    const panel = screen.getByRole("dialog", { name: "辅助面板" });
    expect(panel).toHaveAttribute("data-mode", "tabs");
    expect(screen.queryByText("chat-main")).toBeNull(); // 互斥：面板开时主列隐藏
    fireEvent.click(screen.getByRole("tab", { name: "终端" }));
    expect(screen.getByText("terminal-content")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭辅助面板" }));
    expect(screen.queryByRole("dialog", { name: "辅助面板" })).toBeNull();
    expect(screen.getByText("chat-main")).toBeVisible();
  });

  it("shows an empty hint for a tab without panel content", () => {
    mountShell(<WorkbenchShell viewportWidth={720} open activeTab="routes" />);
    expect(screen.getByText("暂无任务上下文")).toBeVisible();
  });
});

describe("WorkbenchShell tab labels", () => {
  it("offers review, routes, code and terminal in order", () => {
    mountShell(<WorkbenchShell viewportWidth={720} open />);
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["审查", "路线", "代码", "终端"]);
  });
});
