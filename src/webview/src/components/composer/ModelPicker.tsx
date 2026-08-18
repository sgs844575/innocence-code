import { useMemo, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import type { HarnessSettings } from "../../../../shared/ipc";
import { CapabilityTags } from "../tags/CapabilityTags";
import { Popover } from "../ui/Popover";
import { filterProfiles } from "./modelPickerFilter";

interface Props {
  settings: HarnessSettings;
  activeProfileId: string;
  activeModel: string;
  onSelect: (profileId: string, modelId: string) => void;
}

/** 二级模型选择器：厂家列 → 模型列；chip 只显示模型名。 */
export function ModelPicker({ settings, activeProfileId, activeModel, onSelect }: Props): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(activeProfileId);
  const profiles = useMemo(() => filterProfiles(settings, query), [settings, query]);
  const current = profiles.find((p) => p.id === focused) ?? profiles[0];
  const activeModelInfo = settings.profiles
    .find((p) => p.id === activeProfileId)?.models.find((m) => m.id === activeModel);
  const label = activeModelInfo?.name ?? activeModel;

  return (
    <Popover
      align="end"
      contentClassName="w-[340px] overflow-hidden"
      trigger={
        <button
          type="button"
          data-model-picker-trigger
          className="flex max-w-[200px] items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium hover:bg-(--color-app-bubble)"
        >
          <span className="truncate">{label}</span>
          <ChevronDown size={11} className="shrink-0" />
        </button>
      }
    >
      <div className="border-b border-(--color-app-hairline) p-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg) px-2 py-1">
          <Search size={12} className="text-(--color-app-muted)" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模型…"
            className="w-full bg-transparent text-[12px] outline-none placeholder:text-(--color-app-muted)"
          />
        </div>
      </div>
      {/* Two panes scroll independently; the popover never grows past 60vh
          even with hundreds of models (OpenRouter/Ollama) or many providers. */}
      <div className="flex max-h-[min(60vh,420px)] min-h-[196px]">
        <div className="scrollbar-thin w-[104px] shrink-0 overflow-y-auto border-r border-(--color-app-hairline) py-1">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setFocused(p.id)}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] ${p.id === current?.id ? "bg-(--color-app-accent-soft) text-(--color-app-text) shadow-[inset_2px_0_0_var(--color-app-accent)]" : "text-(--color-app-muted) hover:bg-(--color-app-bubble)/50"}`}
            >
              <span className="truncate">{p.name}</span>
            </button>
          ))}
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto py-1">
          {current?.models.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onSelect(current.id, m.id)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-(--color-app-bubble)/50"
            >
              <span className="truncate font-mono text-[11.5px]">{m.name ?? m.id}</span>
              <CapabilityTags model={m} />
              {m.contextWindow != null && (
                <span className="ml-auto shrink-0 rounded-full border border-(--color-app-hairline) px-1.5 font-mono text-[9.5px] text-(--color-app-muted)">
                  {Math.round(m.contextWindow / 1000)}K
                </span>
              )}
              {m.id === activeModel && current.id === activeProfileId && <Check size={12} className="shrink-0 text-(--color-app-accent)" />}
            </button>
          ))}
        </div>
      </div>
    </Popover>
  );
}
