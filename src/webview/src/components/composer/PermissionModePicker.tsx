import { ChevronDown, ShieldCheck } from "lucide-react";
import type { PermissionMode } from "../../../../shared/ipc";
import { Popover } from "../ui/Popover";

const MODES: PermissionMode[] = ["full", "auto", "ask", "plan"];

export function PermissionModePicker({
  t, value, onChange,
}: {
  t: (key: string) => string;
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}): React.JSX.Element {
  // 完全访问（full）用橙色盾牌标示危险档，其余默认色。
  const shieldCls = value === "full" ? "text-amber-500" : "";
  return (
    <Popover
      contentClassName="w-56 p-1"
      trigger={
        <button type="button" className="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] hover:bg-(--color-app-bubble)">
          <ShieldCheck size={13} className={shieldCls} />
          <span>{t(`permission.mode.${value}`)}</span>
          <ChevronDown size={11} />
        </button>
      }
    >
      {MODES.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`flex w-full flex-col items-start rounded-lg px-2.5 py-1.5 text-left text-[11.5px] hover:bg-(--color-app-bubble)/60 ${
            id === value ? (id === "full" ? "text-amber-500" : "text-(--color-app-accent)") : "text-(--color-app-muted)"
          }`}
        >
          <span>{t(`permission.mode.${id}`)}</span>
          <span className="text-[10px] text-(--color-app-muted)/70">{t(`permission.mode.${id}.desc`)}</span>
        </button>
      ))}
    </Popover>
  );
}
