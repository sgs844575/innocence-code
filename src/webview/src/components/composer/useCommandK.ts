import { useEffect } from "react";

/** ⌘K/Ctrl+K 全局快捷键（handler 由调用方注入——Composer 用它点击
 *  ModelPicker 的触发按钮以唤起二级模型面板）。 */
export function useCommandK(handler: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handler]);
}
