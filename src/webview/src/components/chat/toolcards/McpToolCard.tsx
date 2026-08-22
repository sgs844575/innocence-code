import { ChevronRight, Plug } from "lucide-react";
import { RunningMark } from "./RunningMark";
import type { ToolCardProps } from "./registry";

/** 外部工具名约定前缀：mcp__<server>__<tool>（段内单下划线合法，双下划线为分隔）。 */
const MCP_PREFIX = "mcp__";

/** 从工具名解析服务器段与工具段；缺段时退化为仅服务器段展示。 */
function parseMcpName(toolName: string): { server: string; tool: string } {
  const rest = toolName.startsWith(MCP_PREFIX) ? toolName.slice(MCP_PREFIX.length) : toolName;
  const separator = rest.indexOf("__");
  return separator < 0
    ? { server: rest, tool: "" }
    : { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
}

/** 外部服务器通用卡：服务器/工具两段标题 + 参数折叠 + 结果/耗时/错误态。 */
export function McpToolCard({ call, result, open, onToggle }: ToolCardProps): React.JSX.Element {
  const { server, tool } = parseMcpName(call.toolName);
  return (
    <div className={`my-1 overflow-hidden rounded-[10px] border border-(--color-app-hairline) bg-(--color-app-panel) ${result ? "" : "tool-sweep"}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[11px] text-(--color-app-muted) hover:bg-(--color-app-bubble)/40">
        <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <Plug size={12} className="shrink-0 text-(--color-app-accent)" />
        <span className="shrink-0 text-(--color-app-accent)">{server}</span>
        {tool && (
          <>
            <span className="shrink-0 text-(--color-app-muted)/50">::</span>
            <span className="truncate">{tool}</span>
          </>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {result?.durationMs ? (
            <span className="text-[10px] text-(--color-app-muted)/60">{(result.durationMs / 1000).toFixed(1)}s</span>
          ) : null}
          <span className={`text-[10px] ${result?.isError ? "text-(--color-tool-err)" : "text-(--color-tool-ok)"}`}>
            {result ? (result.isError ? "✕" : "✓") : <RunningMark />}
          </span>
        </span>
      </button>
      {open && (
        <div className="border-t border-(--color-app-hairline) px-2.5 py-2 font-mono text-[11px] leading-relaxed text-(--color-app-muted)">
          <pre className="scrollbar-thin max-h-48 overflow-auto">{JSON.stringify(call.args, null, 2)}</pre>
          {result && <pre className="scrollbar-thin mt-1 max-h-48 overflow-auto">{result.content}</pre>}
        </div>
      )}
    </div>
  );
}
