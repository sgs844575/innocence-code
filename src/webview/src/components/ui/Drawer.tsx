import type { ReactNode } from "react";

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}

/** 右侧滑出抽屉（设置页编辑模型等场景）。 */
export function Drawer({ open, title, onClose, children, width = 380 }: Props): React.JSX.Element {
  if (!open) return <></>;
  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="close" onClick={onClose} className="fade-in absolute inset-0 bg-black/25" />
      <div className="drawer-right absolute bottom-0 right-0 top-0 flex flex-col border-l border-(--color-app-border) bg-(--color-app-panel) shadow-(--shadow-pop)" style={{ width }}>
        <div className="flex items-center justify-between border-b border-(--color-app-hairline) px-4 py-3">
          <span className="text-sm font-semibold">{title}</span>
          <button type="button" onClick={onClose} className="text-(--color-app-muted) hover:text-(--color-app-text)">✕</button>
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
