import { BrainCircuit, Eye, Wrench } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import type { ModelInfo } from "../../../../shared/ipc";

interface TagDef { key: "vision" | "tools" | "reasoning"; label: string; Icon: typeof Eye; color: string }

/** 固定顺序 + 颜色的能力标签系统（cherry MODEL_DISPLAY_TAGS 模式）。 */
export const MODEL_DISPLAY_TAGS: TagDef[] = [
  { key: "vision", label: "视觉", Icon: Eye, color: "#00b96b" },
  { key: "tools", label: "工具调用", Icon: Wrench, color: "var(--color-app-accent)" },
  { key: "reasoning", label: "推理", Icon: BrainCircuit, color: "#8b5cf6" },
];

export function CapabilityTags({ model }: { model: ModelInfo }): React.JSX.Element {
  const on = MODEL_DISPLAY_TAGS.filter((t) => model[t.key] === true);
  if (on.length === 0) return <></>;
  return (
    <span className="flex items-center gap-1">
      {on.map(({ key, label, Icon, color }) => (
        <Tooltip key={key} label={label}>
          <span data-testid="cap-tag" title={label} className="grid size-4 place-items-center">
            <Icon size={12} style={{ color }} />
          </span>
        </Tooltip>
      ))}
    </span>
  );
}
