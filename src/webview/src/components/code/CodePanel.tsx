// CodePanel — 只读代码面板（Task 11）：搜索（CodeSearch）+ 文件树
// （CodeFileTree）+ 内容视图（CodeViewer）。所有数据经注入的 api 获取
//（taskId/routeId + 相对路径——渲染层绝不传绝对路径）；外部编辑器入口把
// 当前文件（和可选行/列）交给 main 侧验证后启动。自身只持有展示状态。
import { useCallback, useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import type { CodeFileContent, CodeIpcApi, CodeSearchMatch } from "../../../../shared/codeIpc";
import { zhCN } from "../../lib/i18n";
import { CodeFileTree } from "./CodeFileTree";
import { CodeViewer } from "./CodeViewer";
import { buildFileTree } from "./codeViewModel";
import "../../styles/task.css";

const tZh = (key: string): string => zhCN[key] ?? key;

export interface CodePanelProps {
  taskId: string;
  routeId: string;
  /** 文件树来源（"/"-分隔相对路径的 view model 输入）。 */
  files: readonly string[];
  /** 受控选中路径；缺省时面板自管。 */
  activePath?: string | null;
  api: Pick<CodeIpcApi, "readFile" | "search" | "openExternalEditor">;
  t?: (key: string) => string;
  onSelectFile?: (path: string) => void;
}

export function CodePanel({
  taskId,
  routeId,
  files,
  activePath,
  api,
  t = tZh,
  onSelectFile,
}: CodePanelProps): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(activePath ?? null);
  const [file, setFile] = useState<CodeFileContent | null>(null);
  const [jumpLine, setJumpLine] = useState<{ line: number; column: number } | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<CodeSearchMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tree = useMemo(() => buildFileTree(files), [files]);

  const loadFile = useCallback(
    async (relativePath: string, jump?: { line: number; column: number }) => {
      setSelected(relativePath);
      setJumpLine(jump);
      setError(null);
      try {
        setFile(await api.readFile({ taskId, routeId, relativePath }));
      } catch (cause) {
        setFile(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api, taskId, routeId],
  );

  const handleSelect = useCallback(
    (path: string) => {
      onSelectFile?.(path);
      if (path !== selected) void loadFile(path);
    },
    [onSelectFile, loadFile, selected],
  );

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (trimmed === "") return;
    setError(null);
    try {
      const { matches: found } = await api.search({ taskId, routeId, query: trimmed });
      setMatches(found);
    } catch (cause) {
      setMatches(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, query, taskId, routeId]);

  const openInEditor = useCallback(() => {
    if (selected === null) return;
    void api
      .openExternalEditor({ taskId, routeId, relativePath: selected, ...jumpLine })
      .then((result) => {
        if (!result.launched) setError(result.error ?? t("code.editor.failed"));
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [api, jumpLine, routeId, selected, t, taskId]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-(--color-app-hairline) px-2 py-1.5">
        <Search size={13} className="shrink-0 text-(--color-app-muted)" />
        <input
          type="search"
          aria-label={t("code.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch();
          }}
          placeholder={t("code.search.placeholder")}
          className="h-6 min-w-0 flex-1 rounded border border-(--color-app-border) bg-(--color-app-panel) px-2 text-[11.5px] outline-none focus:border-(--color-app-accent)"
        />
        <button
          type="button"
          onClick={() => void runSearch()}
          className="h-6 shrink-0 rounded bg-(--color-app-accent) px-2 text-[11px] text-(--color-app-accent-fg)"
        >
          {t("code.search.submit")}
        </button>
        <button
          type="button"
          disabled={selected === null}
          title={t("code.editor.open")}
          onClick={openInEditor}
          className="grid size-6 shrink-0 place-items-center rounded text-(--color-app-muted) hover:bg-(--color-app-bubble) disabled:opacity-40"
          aria-label={t("code.editor.open")}
        >
          <ExternalLink size={13} />
        </button>
      </div>

      {error && (
        <div role="alert" className="max-h-16 shrink-0 overflow-auto border-b border-(--color-app-hairline) px-2 py-1 text-[11px] text-red-600">
          {error}
        </div>
      )}

      {matches !== null && (
        <div className="task-code-search-results max-h-40 shrink-0 overflow-auto border-b border-(--color-app-hairline) px-1 py-1">
          {matches.length === 0 ? (
            <div className="px-1.5 py-1 text-[11px] text-(--color-app-muted)">{t("code.search.empty")}</div>
          ) : (
            matches.map((match) => (
              <button
                key={`${match.path}:${match.line}:${match.column}`}
                type="button"
                aria-label={`${t("code.search.jump")} ${match.path}:${match.line}`}
                onClick={() => void loadFile(match.path, { line: match.line, column: match.column })}
                className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-(--color-app-bubble)"
              >
                <span className="shrink-0 font-mono text-[11px] text-(--color-app-accent)">
                  {match.path}:{match.line}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-(--color-app-muted)">
                  {match.preview}
                </span>
              </button>
            ))
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="task-code-tree w-44 shrink-0 overflow-auto border-r border-(--color-app-hairline)">
          <CodeFileTree nodes={tree} activePath={selected} t={t} onSelectFile={handleSelect} />
        </div>
        {file !== null ? (
          <CodeViewer {...file} t={t} />
        ) : (
          <div className="grid flex-1 place-items-center px-4 text-[11.5px] text-(--color-app-muted)">
            {t("code.noSelection")}
          </div>
        )}
      </div>
    </div>
  );
}
