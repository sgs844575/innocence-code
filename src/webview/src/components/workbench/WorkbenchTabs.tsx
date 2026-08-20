// WorkbenchTabs — 辅助面板的页签（审查/路线/代码/终端，Task 11）。纯受控：
// 展示 active 状态并上抛切换命令，内容渲染归 WorkbenchShell。
import { zhCN } from "../../lib/i18n";

const tZh = (key: string): string => zhCN[key] ?? key;

export type WorkbenchTabId = "review" | "routes" | "code" | "terminal";

export const WORKBENCH_TABS: readonly { id: WorkbenchTabId; labelKey: string }[] = [
  { id: "review", labelKey: "workbench.tab.review" },
  { id: "routes", labelKey: "workbench.tab.routes" },
  { id: "code", labelKey: "workbench.tab.code" },
  { id: "terminal", labelKey: "workbench.tab.terminal" },
];

export interface WorkbenchTabsProps {
  active: WorkbenchTabId;
  onSelect: (tab: WorkbenchTabId) => void;
  t?: (key: string) => string;
}

export function WorkbenchTabs({ active, onSelect, t = tZh }: WorkbenchTabsProps): React.JSX.Element {
  return (
    <div role="tablist" aria-label={t("workbench.panel.title")} className="flex min-w-0 flex-1 items-center gap-0.5">
      {WORKBENCH_TABS.map(({ id, labelKey }) => {
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
