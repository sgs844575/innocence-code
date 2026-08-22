// @vitest-environment jsdom
// 面板槽位契约测试：内置四面板注册 → workbench.panel 清单（id/labelKey 序）
// + WorkbenchTabs 派生 + render 闭包新鲜度（panels 更新不重注册——T2 引用稳定契约）。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SlotProvider, useSlotList } from "../../slots/react";
import { BuiltinPanels } from "./builtinPanels";
import { PANEL_SLOT, WorkbenchTabs, type WorkbenchPanelContribution } from "./WorkbenchTabs";

afterEach(cleanup);

/** 探针捕获的槽位清单（每次渲染刷新；用于跨渲染比对快照身份）。 */
let listed: readonly WorkbenchPanelContribution[] = [];

/** 渲染期探针：捕获清单并渲染首个贡献的 render 输出。 */
function Probe(): React.JSX.Element | null {
  listed = useSlotList<WorkbenchPanelContribution>(PANEL_SLOT);
  return <>{listed[0]?.render()}</>;
}

/** 标准装配：Provider + 内置贡献注册 + 单个消费方节点。 */
function mountPanels(
  panels: Partial<Record<"review" | "routes" | "code" | "terminal", React.ReactNode>>,
  child: React.ReactNode,
): ReturnType<typeof render> {
  return render(
    <SlotProvider>
      <BuiltinPanels panels={panels} />
      {child}
    </SlotProvider>,
  );
}

describe("builtin panel contributions", () => {
  it("四个内置面板按固定序注册（id/labelKey）", () => {
    mountPanels({}, <Probe />);
    expect(listed.map(({ id, labelKey }) => ({ id, labelKey }))).toEqual([
      { id: "review", labelKey: "workbench.tab.review" },
      { id: "routes", labelKey: "workbench.tab.routes" },
      { id: "code", labelKey: "workbench.tab.code" },
      { id: "terminal", labelKey: "workbench.tab.terminal" },
    ]);
  });

  it("render 闭包读取最新面板内容；panels 更新不重注册（清单快照身份不变）", () => {
    const first = mountPanels({ review: <p>面板v1</p> }, <Probe />);
    expect(screen.getByText("面板v1")).toBeTruthy();
    const before = listed;

    first.rerender(
      <SlotProvider>
        <BuiltinPanels panels={{ review: <p>面板v2</p> }} />
        <Probe />
      </SlotProvider>,
    );
    expect(screen.getByText("面板v2")).toBeTruthy();
    expect(screen.queryByText("面板v1")).toBeNull();
    // 无重注册：槽位 all() 缓存快照身份稳定（list 重注会重建快照并漂移到队尾）。
    expect(listed).toBe(before);
  });
});

describe("WorkbenchTabs 槽位派生", () => {
  it("页签清单从 workbench.panel 槽位派生（默认 zh 文案序 + 激活态）", () => {
    mountPanels(
      {},
      <WorkbenchTabs active="routes" onSelect={() => {}} />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["审查", "路线", "代码", "终端"]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs.filter((tab) => tab.getAttribute("aria-selected") === "true")).toHaveLength(1);
  });
});
