import { ChevronDown, ShieldCheck } from "lucide-react";
import type { PermissionMode } from "../../../../shared/ipc";
import { Popover } from "../ui/Popover";

const MODES: { id: PermissionMode; desc: string }[] = [
  { id: "auto", desc: "自动执行工具，不打断" },
  { id: "ask", desc: "敏感操作前询问" },
  { id: "plan", desc: "先出计划，批准后执行" },
];

export function PermissionModePicker({
  t, value, onChange,
}: {
  t: (key: string) => string;
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}): React.JSX.Element {
  return (
    <Popover
      contentClassName="w-56 p-1"
      trigger={
        <button type="button" className="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] hover:bg-(--color-app-bubble)">
          <ShieldCheck size={13} />
          <span>{t(`permission.mode.${value}`)}</span>
          <ChevronDown size={11} />
        </button>
      }
    >
      {MODES.map(({ id, desc }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`flex w-full flex-col items-start rounded-lg px-2.5 py-1.5 text-left text-[11.5px] hover:bg-(--color-app-bubble)/60 ${id === value ? "text-(--color-app-accent)" : "text-(--color-app-muted)"}`}
        >
          <span>{t(`permission.mode.${id}`)}</span>
          <span className="text-[10px] text-(--color-app-muted)/70">{desc}</span>
        </button>
      ))}
    </Popover>
  );
}
