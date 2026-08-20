// ResizeHandle — 右侧停靠面板左缘的拖拽调宽把手（Task 11）。纯指针事件：
// pointerdown 后监听 window 的 pointermove/up，逐段回调像素位移；不触碰
// 布局之外的任何状态（宽度持久化由 WorkbenchShell 负责）。
import { useCallback, useEffect, useRef } from "react";

export interface ResizeHandleProps {
  /** 本次拖拽的累计水平位移（向右为正）；拖拽结束回调 end()。 */
  onResize: (deltaPx: number) => void;
  onResizeEnd?: () => void;
  ariaLabel?: string;
}

export function ResizeHandle({
  onResize,
  onResizeEnd,
  ariaLabel = "调整面板宽度",
}: ResizeHandleProps): React.JSX.Element {
  const dragState = useRef<{ pointerId: number; lastX: number } | null>(null);
  // 最新回调走 ref：window 监听只挂一次，不捕获渲染期闭包。
  const callbacks = useRef({ onResize, onResizeEnd });
  callbacks.current = { onResize, onResizeEnd };

  const handleMove = useCallback((event: PointerEvent): void => {
    const drag = dragState.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    callbacks.current.onResize(event.clientX - drag.lastX);
    drag.lastX = event.clientX;
  }, []);

  const handleUp = useCallback((event: PointerEvent): void => {
    const drag = dragState.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragState.current = null;
    callbacks.current.onResizeEnd?.();
  }, []);

  useEffect(() => {
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [handleMove, handleUp]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onPointerDown={(event) => {
        dragState.current = { pointerId: event.pointerId, lastX: event.clientX };
      }}
      className="workbench-resize-handle app-no-drag w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-(--color-app-accent)/40"
    />
  );
}
