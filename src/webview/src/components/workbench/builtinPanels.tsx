// 内置面板贡献：App 装配层的四个面板（审查/路线/代码/终端）注册进
// workbench.panel 槽位。面板 props 来自 App 状态——贡献对象经 useMemo 只构造
// 一次（引用稳定，满足 T2 list 槽位不重注册契约），render 闭包经 ref 读取
// 最新面板内容（App 的 panels memo 更新即时生效，无需重注册/不漂移队尾）。
import { useMemo, useRef } from "react";
import { useRegisterList } from "../../slots/react";
import { PANEL_SLOT, type WorkbenchPanelContribution, type WorkbenchTabId } from "./WorkbenchTabs";

/** 单条注册哑组件：每条贡献独立持钩，规避数组循环内调用钩子（T3 范式）。 */
function Registrar({ contribution }: { contribution: WorkbenchPanelContribution }): React.JSX.Element | null {
  useRegisterList(PANEL_SLOT, contribution);
  return null;
}

/** 挂载于 <SlotProvider> 内：四个内置面板按固定序注册；卸载时整体注销。
 *  兄弟顺序约束：必须渲染在消费方（useWorkbenchTabs 页签派生，经
 *  WorkbenchShell/WorkbenchTabs 树）之前，否则首轮派生读到空清单。 */
export function BuiltinPanels({
  panels,
}: {
  panels: Partial<Record<WorkbenchTabId, React.ReactNode>>;
}): React.JSX.Element {
  // latest ref：render 回调读取 props 的传播形态（App 状态变化不触发重注册）。
  const latest = useRef(panels);
  latest.current = panels;
  const contributions = useMemo<readonly WorkbenchPanelContribution[]>(
    () => [
      { id: "review", labelKey: "workbench.tab.review", render: () => latest.current.review },
      { id: "routes", labelKey: "workbench.tab.routes", render: () => latest.current.routes },
      { id: "code", labelKey: "workbench.tab.code", render: () => latest.current.code },
      { id: "terminal", labelKey: "workbench.tab.terminal", render: () => latest.current.terminal },
    ],
    [],
  );
  return <>{contributions.map((c) => <Registrar key={c.id} contribution={c} />)}</>;
}
