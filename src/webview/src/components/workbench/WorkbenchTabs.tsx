// WorkbenchTabs — 辅助面板的页签（审查/路线/代码/终端，Task 11）。纯受控：
// 展示 active 状态并上抛切换命令，内容渲染归 WorkbenchShell。
// 页签清单自 1c 起从 workbench.panel 槽位派生（内置贡献由 builtinPanels
// 注册；WorkbenchTabId 类型保留内置联合——类型面零破坏，清单运行时从槽位来）。
import { zhCN } from "../../lib/i18n";
import { useSlotList } from "../../slots/react";

const tZh = (key: string): string => zhCN[key] ?? key;

export type WorkbenchTabId = "review" | "routes" | "code" | "terminal";

/** 面板槽位标识：每个页签一条贡献（render 闭包持有该页签的面板内容）。 */
export const PANEL_SLOT = "workbench.panel";

/** 面板槽位的一条贡献：id=页签、labelKey=页签文案、render=面板内容。 */
export interface WorkbenchPanelContribution {
  id: WorkbenchTabId;
  labelKey: string;
  render: () => React.ReactNode;
}

/** 从槽位派生页签清单（注册序保序）。 */
export function useWorkbenchTabs(): readonly { id: WorkbenchTabId; labelKey: string }[] {
  const contributions = useSlotList<WorkbenchPanelContribution>(PANEL_SLOT);
  return contributions.map(({ id, labelKey }) => ({ id, labelKey }));
}

export interface WorkbenchTabsProps {
  active: WorkbenchTabId;
  onSelect: (tab: WorkbenchTabId) => void;
  t?: (key: string) => string;
}

export function WorkbenchTabs({ active, onSelect, t = tZh }: WorkbenchTabsProps): React.JSX.Element {
  const tabs = useWorkbenchTabs();
  return (
    <div role="tablist" aria-label={t("workbench.panel.title")} className="flex min-w-0 flex-1 items-center gap-0.5">
      {tabs.map(({ id, labelKey }) => {
        const isActive = id === active;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(id)}
            className={`h-7 shrink-0 rounded-md px-2.5 text-[12px] ${
              isActive
                ? "bg-(--color-app-bubble) text-(--color-app-text)"
                : "text-(--color-app-muted) hover:bg-(--color-app-bubble)/50"
            }`}
          >
            {t(labelKey)}
          </button>
        );
      })}
    </div>
  );
}
