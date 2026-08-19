import { Bot, Check, ChevronDown } from "lucide-react";
import { Popover } from "../ui/Popover";
import type { AgentId } from "../../../../shared/ipc";

const OPTIONS: { value: AgentId; key: string }[] = [
  { value: "default", key: "agent.default" },
  { value: "plan", key: "agent.plan" },
  { value: "full", key: "agent.full" },
];

/** 内置 agent 下拉（composer 工具栏）：默认/计划/全量，选中项带对勾。
 *  agent 决定系统提示词（执行顺序 + 思考方式预设），与权限模式、思考强度正交。 */
export function AgentPicker({
  t,
  value,
  onChange,
}: {
  t: (key: string) => string;
  value: AgentId;
  onChange: (v: AgentId) => void;
}): React.JSX.Element {
  const label = t(`agent.${value}`);
  return (
    <Popover
      contentClassName="w-32 p-1"
      trigger={
        <button
          type="button"
          aria-label={t("agent.select")}
          className="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] hover:bg-(--color-app-bubble)"
        >
          <Bot size={13} className="shrink-0 text-(--color-app-accent)" />
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
          // plan agent 与同名权限模式易混：挂 desc 提示其为提示词级执行模式。
          title={v === "plan" ? t("agent.plan.desc") : undefined}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] hover:bg-(--color-app-bubble)/60 ${v === value ? "text-(--color-app-accent)" : "text-(--color-app-muted)"}`}
        >
          <span>{t(key)}</span>
          {v === value && <Check size={12} className="ml-auto shrink-0" />}
        </button>
      ))}
    </Popover>
  );
}
