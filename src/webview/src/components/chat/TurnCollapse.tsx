import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolCallPart, ToolResultPart } from "../../../../shared/ipc";
import { ToolCardRow } from "./toolcards/registry";
import { pairTools, summarizeTurn } from "./turnSummary";

interface Props {
  parts: (ToolCallPart | ToolResultPart)[];
  live: boolean;
  t: (key: string) => string;
}

/** 整轮工具活动折叠组：流式展开 → 完成折叠成组行 → 点击下钻到每工具行/明细。 */
export function TurnCollapse({ parts, live, t }: Props): React.JSX.Element {
  const [openGroup, setOpenGroup] = useState(live); // 完成即折叠：live 变 false 时收起
  const [openTools, setOpenTools] = useState<Set<string>>(new Set());
  useEffect(() => { if (!live) setOpenGroup(false); }, [live]);
  const summary = summarizeTurn(parts);
  const pairs = pairTools(parts);

  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setOpenGroup((v) => !v)}
        aria-label={`${summary.count} ${t("chat.turn.operations")} · ${summary.tools.join(" · ")}`}
        className="flex w-full items-center gap-2 rounded-[9px] border border-(--color-app-hairline) bg-(--color-app-accent-soft) px-3 py-1.5 text-left text-[11.5px] text-(--color-app-muted) hover:text-(--color-app-text)"
      >
        <ChevronRight size={13} className={`shrink-0 transition-transform ${openGroup ? "rotate-90" : ""}`} />
        <span className="font-mono text-[10px] font-semibold text-(--color-app-accent)">{summary.count}</span>
        <span>{t("chat.turn.operations")}</span>
        <span className="text-(--color-app-muted)/70">· {summary.tools.join(" · ")}</span>
        {summary.totalMs > 0 && <span className="ml-auto font-mono text-[10px] text-(--color-app-muted)/60">{(summary.totalMs / 1000).toFixed(1)}s</span>}
      </button>
      {openGroup && (
        <div className="mt-1 ml-3 border-l-2 border-(--color-app-hairline) pl-2.5">
          {pairs.map(({ call, result }) => {
            const open = openTools.has(call.id) ?? false;
            return (
              <ToolCardRow
                key={call.id}
                call={call}
                result={result}
                open={open}
                onToggle={() =>
                  setOpenTools((prev) => {
                    const next = new Set(prev);
                    if (next.has(call.id)) next.delete(call.id);
                    else next.add(call.id);
                    return next;
                  })
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
