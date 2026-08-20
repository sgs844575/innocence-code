// Route-scoped CodeSearch (Task 11) — runs ripgrep over one route's workspace
// with an argument array and shell:false (never a shell string), scoped by
// the injected bridge port's route root. Results and output are capped; a
// missing rg degrades to a clear error, never a silent fallback. Electron-free
// by construction (mirrors terminalIpc.ts).
import { spawn as nodeSpawn } from "node:child_process";
import { CodeIpcChannels, type CodeSearchMatch } from "../shared/codeIpc";

/** Minimal process surface the searcher needs (fake-able in tests). */
export interface RgProcess {
  stdout: { on(event: "data", cb: (chunk: string) => void): void };
  stderr: { on(event: "data", cb: (chunk: string) => void): void };
  on(event: "error", cb: (error: Error) => void): this;
  on(event: "close", cb: (code: number | null) => void): this;
  kill(): void;
}

export type RgSpawn = (
  file: string,
  args: string[],
  options: { cwd: string; shell: false },
) => RgProcess;

export interface CodeSearchDeps {
  /** Authoritative route root from the task runtime bridge's route handle. */
  resolveRouteRoot(taskId: string, routeId: string): string | undefined;
  /** Spawn override (tests); defaults to node:child_process spawn. */
  spawn?: RgSpawn;
  /** rg executable; defaults to "rg" resolved from PATH. */
  rgPath?: string;
}

export const CODE_SEARCH_MAX_MATCHES = 200;
/** Output guard: rg is killed once this many characters accumulated. */
const MAX_OUTPUT_CHARS = 512 * 1024;
const RG_TIMEOUT_MS = 15_000;

/** Real spawner (node built-in, no electron): argument array, shell:false. */
const defaultSpawn: RgSpawn = (file, args, options) =>
  nodeSpawn(file, args, { cwd: options.cwd, shell: false, windowsHide: true }) as unknown as RgProcess;

/** vimgrep line: path:line:column:preview (rg always "/"-separates paths). */
function parseVimgrepLine(line: string): CodeSearchMatch | null {
  const match = /^(.+?):(\d+):(\d+):(.*)$/.exec(line);
  if (!match) return null;
  const lineNumber = Number(match[2]);
  const column = Number(match[3]);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return null;
  if (!Number.isSafeInteger(column) || column < 1) return null;
  return { path: match[1].replace(/\\/g, "/"), line: lineNumber, column, preview: match[4] };
}

export interface CodeSearchService {
  /** Resolves the (capped) match list — the brief's arrayContaining shape. */
  search(request: { taskId: string; routeId: string; query: string }): Promise<CodeSearchMatch[]>;
}

export function createCodeSearch(deps: CodeSearchDeps): CodeSearchService {
  const spawnRg = deps.spawn ?? defaultSpawn;
  const rgPath = deps.rgPath ?? "rg";

  return {
    async search(request): Promise<CodeSearchMatch[]> {
      const query = request.query.trim();
      if (!query) throw new Error("code search: query is required");
      const root = deps.resolveRouteRoot(request.taskId, request.routeId);
      if (!root) {
        throw new Error(`code search: unknown task/route: ${request.taskId}/${request.routeId}`);
      }

      // Argument array only — the query rides behind "--" so a leading dash
      // can never become a flag; shell:false keeps it out of any shell.
      const args = [
        "--vimgrep",
        "--no-messages",
        "--smart-case",
        "--max-columns", "240",
        "--max-filesize", "2M",
        "--max-count", "50",
        "--", query,
      ];
      const proc = spawnRg(rgPath, args, { cwd: root, shell: false });

      return new Promise<CodeSearchMatch[]>((resolve, reject) => {
        const matches: CodeSearchMatch[] = [];
        let outputChars = 0;
        let remainder = "";
        let settled = false;

        const settle = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(matches);
        };
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        };

        const ingest = (chunk: string): void => {
          if (settled) return;
          outputChars += chunk.length;
          if (outputChars > MAX_OUTPUT_CHARS) {
            proc.kill();
            settle();
            return;
          }
          remainder += chunk;
          const lines = remainder.split("\n");
          remainder = lines.pop() ?? "";
          for (const line of lines) {
            const parsed = parseVimgrepLine(line);
            if (!parsed) continue;
            matches.push(parsed);
            if (matches.length >= CODE_SEARCH_MAX_MATCHES) {
              proc.kill();
              settle();
              return;
            }
          }
        };

        const timer = setTimeout(() => {
          proc.kill();
          settle();
        }, RG_TIMEOUT_MS);

        proc.stdout.on("data", ingest);
        proc.stderr.on("data", () => undefined); // drained; --no-messages keeps it quiet
        proc.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            fail(new Error(`code search: rg is not available on PATH (${rgPath})`));
          } else {
            fail(new Error(`code search: rg failed to start: ${error.message}`));
          }
        });
        proc.on("close", (code) => {
          if (settled) return;
          if (remainder !== "") ingest("\n");
          // rg exit 1 = "no matches" (not an error); 2+ is a real failure.
          if (code !== null && code >= 2) fail(new Error(`code search: rg exited with code ${code}`));
          else settle();
        });
      });
    },
  };
}

/** Registers the ipcMain handler (Electron host composition only). */
export async function registerCodeSearchIpc(service: CodeSearchService): Promise<void> {
  const { ipcMain } = await import("electron");
  ipcMain.handle(CodeIpcChannels.codeSearch, async (_e, req) => ({
    matches: await service.search(req),
  }));
}
