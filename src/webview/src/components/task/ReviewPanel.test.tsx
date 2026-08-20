// @vitest-environment jsdom
// ReviewPanel / HunkRow / taskViewModel 纯映射测试（Task 10）。
// 状态由 IPC view model 驱动：这里只断言 props → 渲染 / 回调，不实现任务 reducer。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HunkRow } from "./HunkRow";
import { ReviewPanel } from "./ReviewPanel";
import { groupHunksByFile, summarizeChanges, type TaskHunk } from "./taskViewModel";

// jest-dom 子集：brief 原文断言用 toBeVisible/toBeEnabled；项目未引入
// @testing-library/jest-dom，这里只补这两个匹配器的最小语义（jsdom 无布局）。
declare module "vitest" {
  interface Assertion<T = any> {
    toBeVisible(): void;
    toBeEnabled(): void;
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
});

const hunk: TaskHunk = {
  ref: "t1:0",
  path: "src/a.ts",
  before: "a\n",
  after: "b\n",
  context: [],
  status: "pending",
};

function fileWithHunks(...statuses: TaskHunk["status"][]) {
  const hunks = statuses.map((status, i) => ({
    ...hunk,
    ref: `t1:${i}`,
    path: "src/a.ts",
    status,
  }));
  return groupHunksByFile(hunks)[0];
}

afterEach(cleanup);

describe("ReviewPanel", () => {
  it("shows accepted and pending hunks separately", () => {
    render(<ReviewPanel files={[fileWithHunks("accepted", "pending")]} />);
    expect(screen.getByText("已接受")).toBeVisible();
    expect(screen.getByText("待审查")).toBeVisible();
  });

  it("batch accept sends a single ledger command with a null hunkRef", () => {
    const onReview = vi.fn();
    render(
      <ReviewPanel
        files={[fileWithHunks("pending", "pending")]}
        taskId="t1"
        routeId="r1"
        expectedVersion="v3"
        onReview={onReview}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "全部接受" }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onReview).toHaveBeenCalledWith({
      taskId: "t1",
      routeId: "r1",
      hunkRef: null,
      status: "accepted",
      expectedVersion: "v3",
    });
  });

  it("file accept reviews every hunk in that file individually", () => {
    const onReview = vi.fn();
    render(
      <ReviewPanel
        files={[fileWithHunks("pending", "pending", "accepted")]}
        taskId="t1"
        routeId="r1"
        expectedVersion="v3"
        onReview={onReview}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "接受此文件" }));
    expect(onReview).toHaveBeenCalledTimes(3);
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ hunkRef: "t1:0" }));
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ hunkRef: "t1:1" }));
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ hunkRef: "t1:2" }));
  });

  it("hunk accept emits one command scoped to that hunk", () => {
    const onReview = vi.fn();
    render(
      <ReviewPanel
        files={[fileWithHunks("pending")]}
        taskId="t1"
        routeId="r1"
        expectedVersion="v3"
        onReview={onReview}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "接受" }));
    expect(onReview).toHaveBeenCalledWith({
      taskId: "t1",
      routeId: "r1",
      hunkRef: "t1:0",
      status: "accepted",
      expectedVersion: "v3",
    });
  });

  it("hunk restore carries expectedVersion", () => {
    const onRestore = vi.fn();
    render(
      <ReviewPanel
        files={[fileWithHunks("accepted")]}
        taskId="t1"
        routeId="r1"
        expectedVersion="v7"
        onRestore={onRestore}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "还原" }));
    expect(onRestore).toHaveBeenCalledWith({
      taskId: "t1",
      routeId: "r1",
      hunkRef: "t1:0",
      expectedVersion: "v7",
    });
  });

  it("selecting a hunk emits its hunkRef for the composer request", () => {
    const onHunkSelected = vi.fn();
    render(
      <ReviewPanel
        files={[fileWithHunks("pending")]}
        onHunkSelected={onHunkSelected}
      />,
    );
    fireEvent.click(screen.getByRole("listitem"));
    expect(onHunkSelected).toHaveBeenCalledWith("t1:0");
  });
});

describe("HunkRow", () => {
  it("never renders conflict as accepted", () => {
    render(<HunkRow hunk={{ ...hunk, status: "conflict" }} />);
    expect(screen.queryByRole("button", { name: "接受" })).not.toBeEnabled();
    expect(screen.getByText("冲突")).toBeVisible();
  });

  it("shows +/− line stats beside the status", () => {
    render(<HunkRow hunk={{ ...hunk, before: "a\nb\n", after: "c\nd\ne\n" }} />);
    expect(screen.getByText("+3")).toBeTruthy();
    expect(screen.getByText("−2")).toBeTruthy();
  });
});

describe("taskViewModel", () => {
  it("groups hunks by file preserving first-seen order and sums line stats", () => {
    const groups = groupHunksByFile([
      { ...hunk, ref: "t1:0", path: "src/b.ts", before: "x\n", after: "y\nz\n" },
      { ...hunk, ref: "t1:1", path: "src/a.ts", before: "", after: "new\n" },
      { ...hunk, ref: "t1:2", path: "src/b.ts", before: "m\nn\n", after: "" },
    ]);
    expect(groups.map((g) => g.path)).toEqual(["src/b.ts", "src/a.ts"]);
    expect(groups[0].hunks.map((h) => h.ref)).toEqual(["t1:0", "t1:2"]);
    expect(groups[0].added).toBe(2);
    expect(groups[0].removed).toBe(3);
    expect(groups[1].added).toBe(1);
    expect(groups[1].removed).toBe(0);
  });

  it("summarizes file count, additions, deletions and review statuses", () => {
    const summary = summarizeChanges([
      { ...hunk, ref: "t1:0", path: "src/a.ts", before: "a\n", after: "b\nc\n", status: "accepted" },
      { ...hunk, ref: "t1:1", path: "src/a.ts", before: "d\n", after: "", status: "pending" },
      { ...hunk, ref: "t1:2", path: "src/b.ts", before: "", after: "n\n", status: "conflict" },
      { ...hunk, ref: "t1:3", path: "src/c.ts", before: "o\n", after: "p\n", status: "restored" },
    ]);
    expect(summary.fileCount).toBe(3);
    expect(summary.added).toBe(4);
    expect(summary.removed).toBe(3);
    expect(summary.accepted).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.conflicts).toBe(1);
    expect(summary.restored).toBe(1);
    expect(summary.unreviewed).toBe(2); // pending + conflict
  });
});
