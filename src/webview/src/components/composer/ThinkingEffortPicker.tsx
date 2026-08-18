import { BrainCircuit, Check, ChevronDown } from "lucide-react";
import { Popover } from "../ui/Popover";

export type EffortValue = "" | "off" | "low" | "medium" | "high";

const OPTIONS: { value: EffortValue; key: string }[] = [
  { value: "", key: "reasoning.effort.default" },
  { value: "off", key: "reasoning.effort.off" },
  { value: "low", key: "reasoning.effort.low" },
  { value: "medium", key: "reasoning.effort.medium" },
  { value: "high", key: "reasoning.effort.high" },
];

/** 思考强度下拉（composer 工具栏）：默认/关闭/低/中/高，选中项带对勾。
 *  档位对所有模型可见——中转站模型元数据缺失时也能设置。 */
export function ThinkingEffortPicker({
  t,
  value,
  onChange,
}: {
  t: (key: string) => string;
  value: EffortValue;
  onChange: (v: EffortValue) => void;
}): React.JSX.Element {
  const label = t(`reasoning.effort.${value === "" ? "default" : value}`);
  return (
    <Popover
      contentClassName="w-32 p-1"
      trigger={
        <button
          type="button"
          aria-label={t("reasoning.effort")}
          className="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] hover:bg-(--color-app-bubble)"
        >
          <BrainCircuit size={13} className="shrink-0 text-(--color-app-accent)" />
          <span>{label}</span>
          <ChevronDown size={11} className="shrink-0" />
        </button>
      }
    >
      {OPTIONS.map(({ value: v, key }) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] hover:bg-(--color-app-bubble)/60 ${v === value ? "text-(--color-app-accent)" : "text-(--color-app-muted)"}`}
        >
          <span>{t(key)}</span>
          {v === value && <Check size={12} className="ml-auto shrink-0" />}
        </button>
      ))}
    </Popover>
  );
}
