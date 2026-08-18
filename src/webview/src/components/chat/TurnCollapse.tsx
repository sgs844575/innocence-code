import type { ToolCallPart, ToolResultPart } from "../../../../shared/ipc";

interface Props {
  parts: (ToolCallPart | ToolResultPart)[];
  live: boolean;
  t: (key: string) => string;
}

// 最小占位实现——任务 10 重写为完整折叠/状态交互，接口保持 { parts, live, t } 不变。
export function TurnCollapse({ parts, live }: Props): React.JSX.Element {
  return (
    <div
      className={`my-1 space-y-1 font-mono text-xs text-(--color-app-muted) ${live ? "animate-pulse" : ""}`}
    >
      {parts.map((part, i) =>
        part.type === "toolCall" ? (
          <div key={`${part.id}-${i}`} className="truncate">
            {part.toolName} {JSON.stringify(part.args)}
          </div>
        ) : (
          <div key={`${part.toolCallId}-r-${i}`} className="truncate opacity-80">
            &crarr; {part.content}
          </div>
        ),
      )}
    </div>
  );
}
