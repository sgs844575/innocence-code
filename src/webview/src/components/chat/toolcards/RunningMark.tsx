import { Loader2 } from "lucide-react";

/** 工具卡行尾的运行中标记：旋转图标（替代原先静态的"…"）。 */
export function RunningMark(): React.JSX.Element {
  return <Loader2 size={11} className="ml-auto shrink-0 animate-spin text-(--color-tool-running)" />;
}
