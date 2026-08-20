// AppShell — 响应式导航/布局外壳（Task 12 从 App.tsx 拆出）。
// 三段式导航：宽窗（≥1024）停靠整列侧栏（或手动图标轨）；中窗（640-1023）
// 恒显图标轨 + 覆盖式抽屉；窄窗（<640）仅抽屉。视图切换（chat/settings）、
// 抽屉/轨模式、工作台面板布局都归这里；内容节点由 App 以渲染属性注入，
// 布局回调（openSettings/backToChat/closeDrawerOnNavigate 等）随 nav 透出。
// bindNav 把 nav 句柄交给宿主，供渲染属性之外的原生菜单等入口使用。
import { useCallback, useEffect, useState } from "react";
import type { SettingsSection } from "./SettingsNav";
import { WorkbenchShell, useWorkbenchLayout } from "./workbench/WorkbenchShell";
import type { WorkbenchTabId } from "./workbench/WorkbenchTabs";
import { useMediaQuery } from "../lib/useMediaQuery";

export interface AppShellNav {
  view: "chat" | "settings";
  section: SettingsSection;
  isWide: boolean;
  /** 标题栏折叠按钮当前语义下的侧栏开合（宽屏 = 整列，其余 = 抽屉）。 */
  sidebarOpen: boolean;
  openSettings: () => void;
  backToChat: () => void;
  selectSection: (section: SettingsSection) => void;
  toggleSidebar: () => void;
  /** 图标轨「展开侧栏」：宽屏退出轨模式，其余开抽屉。 */
  expandNav: () => void;
  /** 任意导航选择后调用：overlay 模式下收起抽屉。 */
  closeDrawerOnNavigate: () => void;
  workbench: ReturnType<typeof useWorkbenchLayout>;
}

export interface AppShellProps {
  t: (key: string) => string;
  /** 标题栏（拿到 workbench 开关与终端入口）。 */
  titleBar: (nav: AppShellNav) => React.ReactNode;
  /** 整列导航内容（聊天侧栏 / 设置菜单）。 */
  sidebar: (nav: AppShellNav) => React.ReactNode;
  /** 图标轨内容（聊天 / 设置两态）。 */
  rail: (nav: AppShellNav) => React.ReactNode;
  /** 聊天主列（WorkbenchShell 内部）。 */
  chat: React.ReactNode;
  /** 设置主列（渲染属性：section 归 AppShell）；null = 未加载设置。 */
  settings: (nav: AppShellNav) => React.ReactNode | null;
  /** 辅助面板各页签内容。 */
  panels: Partial<Record<WorkbenchTabId, React.ReactNode>>;
  /** 恢复告警横幅（App 组装文案与按钮）。 */
  banner?: React.ReactNode;
  /** 错误提示 toast（4s 自动消失由 App 管理）。 */
  toast?: string | null;
  /** 挂载时交付 nav 句柄（原生菜单等渲染属性之外的入口用）。 */
  bindNav?: (nav: AppShellNav) => void;
}

export function AppShell({
  t,
  titleBar,
  sidebar,
  rail,
  chat,
  settings,
  panels,
  banner,
  toast,
  bindNav,
}: AppShellProps): React.JSX.Element {
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [section, setSection] = useState<SettingsSection>("models");

  const isWide = useMediaQuery("(min-width: 1024px)");
  const isMedium = useMediaQuery("(min-width: 640px)") && !isWide;
  const [railMode, setRailMode] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The overlay drawer only exists below the wide breakpoint.
  useEffect(() => {
    if (isWide) setDrawerOpen(false);
  }, [isWide]);

  const workbench = useWorkbenchLayout();

  const closeDrawerOnNavigate = useCallback(() => {
    if (!isWide) setDrawerOpen(false);
  }, [isWide]);

  const openSettings = useCallback(() => {
    setView("settings");
    closeDrawerOnNavigate();
  }, [closeDrawerOnNavigate]);

  const backToChat = useCallback(() => setView("chat"), []);

  const selectSection = useCallback(
    (next: SettingsSection) => {
      setSection(next);
      closeDrawerOnNavigate();
    },
    [closeDrawerOnNavigate],
  );

  const toggleSidebar = useCallback(() => {
    if (isWide) setRailMode((v) => !v);
    else setDrawerOpen((v) => !v);
  }, [isWide]);

  const expandNav = useCallback(() => {
    if (isWide) setRailMode(false);
    else setDrawerOpen(true);
  }, [isWide]);

  const nav: AppShellNav = {
    view,
    section,
    isWide,
    sidebarOpen: isWide ? !railMode : drawerOpen,
    openSettings,
    backToChat,
    selectSection,
    toggleSidebar,
    expandNav,
    closeDrawerOnNavigate,
    workbench,
  };
  bindNav?.(nav);

  const inSettings = view === "settings";
  const navFull = sidebar(nav);
  const navRail = rail(nav);
  const settingsNode = settings(nav);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-(--color-app-bg) text-(--color-app-text)">
      {titleBar(nav)}
      {banner}
      {/* One continuous surface: sidebar column (sidebar tone) + content
          column (panel tone), separated by hairlines only. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {isWide && !railMode && (
          <div className="w-[clamp(232px,20vw,288px)] shrink-0 border-r border-(--color-app-hairline) bg-(--color-app-sidebar)">
            {navFull}
          </div>
        )}
        {(isWide && railMode) || isMedium ? (
          <div className="w-12 shrink-0 border-r border-(--color-app-hairline) bg-(--color-app-sidebar)">
            {navRail}
          </div>
        ) : null}
        <main className="min-w-0 flex-1 overflow-hidden bg-(--color-app-panel)">
          {inSettings && settingsNode !== null ? (
            settingsNode
          ) : (
            <WorkbenchShell
              open={workbench.open}
              activeTab={workbench.tab}
              onTabChange={workbench.setTab}
              onClose={() => workbench.setOpen(false)}
              panels={panels}
              t={t}
            >
              {chat}
            </WorkbenchShell>
          )}
        </main>
      </div>

      {/* Medium/narrow windows: overlay drawer with a scrim, flush against
          the left edge below the title bar. */}
      {!isWide && drawerOpen && (
        <div className="fixed inset-x-0 bottom-0 top-9 z-40">
          <button
            type="button"
            aria-label={t("sidebar.close")}
            onClick={() => setDrawerOpen(false)}
            className="fade-in absolute inset-0 bg-black/25"
          />
          <div className="drawer-in absolute bottom-0 left-0 top-0 w-[clamp(240px,72vw,300px)] border-r border-(--color-app-border) bg-(--color-app-sidebar) shadow-(--shadow-pop)">
            {navFull}
          </div>
        </div>
      )}

      {toast && (
        <div
          role="alert"
          className="toast-in card-strong fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-sm"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
