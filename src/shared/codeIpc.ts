// Code IPC channels and DTOs — the renderer-facing contract for the read-only
// code panel and the external editor entry (Task 11). Mirrors taskIpc.ts /
// terminalIpc.ts conventions:
//   - Renderer requests carry ONLY taskId/routeId (+ route-relative path or
//     query text) — never absolute paths. The main process resolves the route
//     workspace root through the task runtime bridge and rejects anything
//     that escapes it.
//   - Responses are read-only views: the renderer can never write through
//     this surface.

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export const CodeIpcChannels = {
  codeReadFile: "code:read-file",
  codeListFiles: "code:list-files",
  codeSearch: "code:search",
  codeOpenExternalEditor: "code:open-external-editor",
} as const;

// ---------------------------------------------------------------------------
// Request / Response DTOs per channel
// ---------------------------------------------------------------------------

export interface CodeReadFileRequest {
  taskId: string;
  routeId: string;
  /** Route-relative "/"-separated path; absolute/traversal paths are rejected. */
  relativePath: string;
}

/** File content view. Binary files carry metadata only (content: ""). */
export interface CodeFileContent {
  path: string;
  /** "" for binary or oversized files. */
  content: string;
  language: string;
  readOnly: true;
  binary: boolean;
  /** Oversized text was cut at the read cap (viewer shows a notice). */
  truncated: boolean;
  size: number;
}

export interface CodeListFilesRequest {
  taskId: string;
  routeId: string;
}

export interface CodeListFilesResponse {
  /** "/"-separated relative paths, sorted; ".git" internals never included. */
  files: string[];
}

export interface CodeSearchRequest {
  taskId: string;
  routeId: string;
  query: string;
}

export interface CodeSearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface CodeSearchResponse {
  matches: CodeSearchMatch[];
}

export interface ExternalEditorOpenRequest {
  taskId: string;
  routeId: string;
  relativePath: string;
  line?: number;
  column?: number;
}

export interface ExternalEditorOpenResponse {
  launched: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Renderer-callable API surface (typed; the preload bridge implements it)
// ---------------------------------------------------------------------------

export interface CodeIpcApi {
  readFile(request: CodeReadFileRequest): Promise<CodeFileContent>;
  listFiles(request: CodeListFilesRequest): Promise<CodeListFilesResponse>;
  search(request: CodeSearchRequest): Promise<CodeSearchResponse>;
  openExternalEditor(request: ExternalEditorOpenRequest): Promise<ExternalEditorOpenResponse>;
}
