// WorkbenchShell — 可停靠辅助面板外壳（Task 11）。响应式三形态：
//   宽屏（≥1024）：主列 + 右侧 320-720px 可拖拽调宽的停靠面板；
//   中屏（640-1023）：覆盖式面板（scrim + 右缘滑入）；
//   窄屏（<640）：互斥 tab——面板打开时主列让位，关闭后回到主列。
// 外壳只管 chrome（页签/调宽/开关/形态），面板内容由宿主以 ReactNode 注入；
// 终端面板保持常驻挂载（xterm scrollback 不因切页签而丢失）。
import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { zhCN } from "../../lib/i18n";
import { WorkbenchTabs, type WorkbenchTabId } from "./WorkbenchTabs";
import { ResizeHandle } from "./ResizeHandle";
import "../../styles/workbench.css";

const tZh = (key: string): string => zhCN[key] ?? key;

const WIDE_BREAKPOINT = 1024;
const NARROW_BREAKPOINT = 640;
export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 720;
const PANEL_DEFAULT_WIDTH = 360;
const WIDTH_STORAGE_KEY = "workbench:panel-width";

export type WorkbenchMode = "docked" | "overlay" | "tabs";

export interface WorkbenchShellProps {
  /** 测试注入的视口宽度；缺省跟踪 window 宽度。 */
  viewportWidth?: number;
  /** 受控开关（缺省非受控，默认 true）。 */
  open?: boolean;
  onClose?: () => void;
  /** 受控页签（缺省非受控，默认 review）。 */
  activeTab?: WorkbenchTabId;
  onTabChange?: (tab: WorkbenchTabId) => void;
  /** 主列（聊天）；窄屏面板打开时隐藏。 */
  children?: React.ReactNode;
  /** 各页签内容；未提供的页签显示占位。 */
  panels?: Partial<Record<WorkbenchTabId, React.ReactNode>>;
  t?: (key: string) => string;
}

const clampPanelWidth = (width: number): number =>
  Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(width)));

function readStoredWidth(): number {
  if (typeof window === "undefined") return PANEL_DEFAULT_WIDTH;
  const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? clampPanelWidth(parsed) : PANEL_DEFAULT_WIDTH;
}

export function modeForWidth(viewportWidth: number): WorkbenchMode {
  if (viewportWidth >= WIDE_BREAKPOINT) return "docked";
  if (viewportWidth >= NARROW_BREAKPOINT) return "overlay";
  return "tabs";
}

/** App 用的极小布局状态钩子：开关 + 当前页签 + 终端入口。 */
export function useWorkbenchLayout(): {
  open: boolean;
  tab: WorkbenchTabId;
  setOpen: (open: boolean) => void;
  togglePanel: () => void;
  openTerminal: () => void;
  setTab: (tab: WorkbenchTabId) => void;
} {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<WorkbenchTabId>("review");
  const togglePanel = useCallback(() => setOpen((value) => !value), []);
  const openTerminal = useCallback(() => {
    setTab("terminal");
    setOpen(true);
  }, []);
  return { open, tab, setOpen, togglePanel, openTerminal, setTab };
}

export function WorkbenchShell({
  viewportWidth,
  open,
  onClose,
  activeTab,
  onTabChange,
  children,
  panels = {},
  t = tZh,
}: WorkbenchShellProps): React.JSX.Element {
  // 视口宽度：测试直传，宿主跟踪 window resize。
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window === "undefined" ? WIDE_BREAKPOINT : window.innerWidth,
  );
  useEffect(() => {
    if (viewportWidth !== undefined || typeof window === "undefined") return;
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [viewportWidth]);
  const mode = modeForWidth(viewportWidth ?? windowWidth);

  // 开关：受控优先，宿主未传时非受控；关闭动作通过 dismissed 覆盖受控值，
  // 受控值变化（App 再次打开）时复位。
  const [openState, setOpenState] = useState(open ?? true);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(false);
    if (open !== undefined) setOpenState(open);
  }, [open]);
  const isOpen = (open ?? openState) && !dismissed;
  const close = useCallback(() => {
    setDismissed(true);
    setOpenState(false);
    onClose?.();
  }, [onClose]);

  // 页签：同款受控-可选模式。
  const [tabState, setTabState] = useState<WorkbenchTabId>(activeTab ?? "review");
  useEffect(() => {
    if (activeTab !== undefined) setTabState(activeTab);
  }, [activeTab]);
  const active = activeTab ?? tabState;
  const selectTab = useCallback(
    (tab: WorkbenchTabId) => {
      setTabState(tab);
      onTabChange?.(tab);
    },
    [onTabChange],
  );

  // 停靠宽度：拖拽逐段回调，拖完持久化。
  const [panelWidth, setPanelWidth] = useState(readStoredWidth);
  const onResize = useCallback((deltaPx: number) => {
    // 面板左缘向左拖（负位移）加宽。
    setPanelWidth((prev) => clampPanelWidth(prev - deltaPx));
  }, []);
  const onResizeEnd = useCallback(() => {
    setPanelWidth((width) => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
      }
      return width;
    });
  }, []);

  const panelBody = (widthStyle: React.CSSProperties | undefined, className: string) => (
    <div
      role="dialog"
      aria-label={t("workbench.panel.title")}
      data-mode={mode}
      style={widthStyle}
      className={className}
    >
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-(--color-app-hairline) px-2">
        <WorkbenchTabs active={active} onSelect={selectTab} t={t} />
        <button
          type="button"
          aria-label={t("workbench.panel.close")}
          onClick={close}
          className="grid size-7 shrink-0 place-items-center rounded text-(--color-app-muted) hover:bg-(--color-app-bubble)"
        >
          <X size={14} />
        </button>
      </header>
      <div className="workbench-panel-body scrollbar-thin flex min-h-0 flex-1 flex-col overflow-auto">
        {(Object.keys(panels) as WorkbenchTabId[]).map((id) => {
          const visible = id === active;
          // 终端面板常驻挂载（xterm scrollback 不因切页签而丢）；其余页签
          // 按需挂载——卸载即从可访问树移除。
          if (!visible && id !== "terminal") return null;
          return (
            <div
              key={id}
              className="flex min-h-0 flex-1 flex-col"
              style={{ display: visible ? undefined : "none" }}
            >
              {panels[id]}
            </div>
          );
        })}
        {panels[active] === undefined && (
          <div className="grid flex-1 place-items-center px-4 py-8 text-[12px] text-(--color-app-muted)">
            {t("workbench.empty")}
          </div>
        )}
      </div>
    </div>
  );

  // 窄屏互斥：面板打开即独占主区。
  if (mode === "tabs") {
    if (!isOpen) {
      return <div className="flex h-full min-h-0 w-full">{children}</div>;
    }
    return panelBody(undefined, "flex h-full min-h-0 w-full flex-col bg-(--color-app-panel)");
  }

  if (mode === "overlay") {
    return (
      <div className="relative flex h-full min-h-0 w-full">
        {children}
        {isOpen && (
          <div className="fixed inset-x-0 bottom-0 top-9 z-40">
            <button
              type="button"
              aria-label={t("workbench.panel.close")}
              onClick={close}
              className="fade-in absolute inset-0 bg-black/25"
            />
            {panelBody(
              undefined,
              "drawer-right absolute bottom-0 right-0 top-0 flex w-[clamp(320px,80vw,480px)] flex-col border-l border-(--color-app-border) bg-(--color-app-panel) shadow-(--shadow-pop)",
            )}
          </div>
        )}
      </div>
    );
  }

  // docked：主列 + 调宽把手 + 停靠面板（关闭时整列收起）。
  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
      {isOpen && (
        <>
          <ResizeHandle onResize={onResize} onResizeEnd={onResizeEnd} ariaLabel={t("workbench.resize")} />
          {panelBody(
            { width: `${panelWidth}px` },
            "flex h-full min-h-0 shrink-0 flex-col border-l border-(--color-app-hairline) bg-(--color-app-panel)",
          )}
        </>
      )}
    </div>
  );
}
