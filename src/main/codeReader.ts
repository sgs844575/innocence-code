// Route-scoped CodeReader (Task 11) — the main-process read surface behind
// the workbench's read-only code panel. Electron-free by construction
// (mirrors terminalIpc.ts): the reader resolves each request's workspace
// root through an injected bridge port (renderer requests carry
// taskId/routeId + a route-relative path only) and rejects everything that
// could escape that root:
//   - unsafe relative paths (absolute, drive letters, "..", "\", NUL),
//   - unknown task/route (ownership),
//   - symlinked path segments at read time (lstat per segment).
// Binary files return file-level metadata only — never content.
import fs from "node:fs/promises";
import path from "node:path";
import { isSafeRelativePath } from "@innocencecode/secure-storage-node";
import { CodeIpcChannels, type CodeFileContent, type CodeListFilesResponse } from "../shared/codeIpc";

/** Brief-verbatim reader surface; results carry the metadata superset. */
export interface CodeReader {
  readFile(input: { taskId: string; routeId: string; relativePath: string }): Promise<{
    path: string;
    content: string;
    language: string;
    readOnly: true;
  }>;
}

export interface CodeReaderService extends CodeReader {
  /** Covariant refinement of the base reader: binary/oversize metadata. */
  readFile(input: { taskId: string; routeId: string; relativePath: string }): Promise<CodeFileContent>;
  /** Route file list ("/"-separated, sorted, .git internals excluded). */
  listFiles(input: { taskId: string; routeId: string }): Promise<CodeListFilesResponse>;
}

export interface CodeReaderDeps {
  /** Authoritative route root from the task runtime bridge's route handle. */
  resolveRouteRoot(taskId: string, routeId: string): string | undefined;
}

/** Text content beyond this is cut (the viewer shows a truncation notice). */
export const MAX_CODE_CONTENT_BYTES = 1_000_000;
/** NUL byte within the first 8000 bytes marks content as binary (git heuristic). */
const BINARY_SNIFF_BYTES = 8000;

const EXTENSION_LANGUAGES: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".json": "json", ".jsonc": "json", ".css": "css", ".scss": "scss", ".less": "less",
  ".html": "html", ".htm": "html", ".md": "markdown", ".mdx": "markdown",
  ".py": "python", ".rs": "rust", ".go": "go", ".java": "java", ".kt": "kotlin",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp",
  ".yml": "yaml", ".yaml": "yaml", ".toml": "toml", ".xml": "xml", ".svg": "xml",
  ".sh": "shell", ".ps1": "powershell", ".sql": "sql", ".txt": "text",
};

function languageOf(relativePath: string): string {
  return EXTENSION_LANGUAGES[path.posix.extname(relativePath).toLowerCase()] ?? "text";
}

function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i += 1) if (bytes[i] === 0) return true;
  return false;
}

/** lstat every segment: a symlink anywhere on the route rejects the read. */
async function assertNoSymlinkSegments(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => {
      throw new Error(`code reader: file not found: ${relativePath}`);
    });
    if (stat.isSymbolicLink()) {
      throw new Error(`code reader: relativePath is outside workspace (symlink): ${relativePath}`);
    }
  }
}

/**
 * Shared route-file guard: safe relative path + per-segment symlink rejection
 * + regular-file check. Returns the absolute path under the route root.
 * Consumed by the code reader and the external editor launcher.
 */
export async function assertRouteFile(root: string, relativePath: string): Promise<string> {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`code reader: relativePath is outside workspace: ${JSON.stringify(relativePath)}`);
  }
  await assertNoSymlinkSegments(root, relativePath);
  const absolute = path.join(root, ...relativePath.split("/"));
  const stat = await fs.stat(absolute).catch(() => {
    throw new Error(`code reader: file not found: ${relativePath}`);
  });
  if (!stat.isFile()) throw new Error(`code reader: not a regular file: ${relativePath}`);
  return absolute;
}

/** Walks the route root; ".git" internals never appear in the listing. */
async function listRelativeFiles(root: string, dir = "", out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir ? path.join(root, ...dir.split("/")) : root, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await listRelativeFiles(root, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export function createCodeReader(deps: CodeReaderDeps): CodeReaderService {
  function routeRoot(taskId: string, routeId: string): string {
    const root = deps.resolveRouteRoot(taskId, routeId);
    if (!root) throw new Error(`code reader: unknown task/route: ${taskId}/${routeId}`);
    return root;
  }

  return {
    async readFile({ taskId, routeId, relativePath }): Promise<CodeFileContent> {
      const root = routeRoot(taskId, routeId);
      const absolute = await assertRouteFile(root, relativePath);
      const bytes = new Uint8Array(await fs.readFile(absolute));
      if (looksBinary(bytes)) {
        return { path: relativePath, content: "", language: "binary", readOnly: true, binary: true, truncated: false, size: bytes.length };
      }
      const truncated = bytes.length > MAX_CODE_CONTENT_BYTES;
      const slice = truncated ? bytes.subarray(0, MAX_CODE_CONTENT_BYTES) : bytes;
      return {
        path: relativePath,
        content: new TextDecoder("utf-8", { fatal: false }).decode(slice),
        language: languageOf(relativePath),
        readOnly: true,
        binary: false,
        truncated,
        size: bytes.length,
      };
    },

    async listFiles({ taskId, routeId }): Promise<CodeListFilesResponse> {
      const root = routeRoot(taskId, routeId);
      const files = await listRelativeFiles(root).catch((error) => {
        throw new Error(`code reader: listing failed: ${String(error)}`);
      });
      return { files: files.sort() };
    },
  };
}

/**
 * Registers the ipcMain handlers. Dynamic import keeps this module loadable in
 * Node (vitest) — only the Electron host calls this function (composition
 * lands with the task-context wiring task, same as registerTaskIpcHandlers).
 */
export async function registerCodeReaderIpc(service: CodeReaderService): Promise<void> {
  const { ipcMain } = await import("electron");
  ipcMain.handle(CodeIpcChannels.codeReadFile, (_e, req) => service.readFile(req));
  ipcMain.handle(CodeIpcChannels.codeListFiles, (_e, req) => service.listFiles(req));
}
