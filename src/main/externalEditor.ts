// ExternalEditor launcher (Task 11) — opens a validated route-relative file
// at an optional line/column in the user-configured editor command. The
// command is parsed into an executable + argument tokens (a leading quoted
// path is honored) and spawned with an argument array, shell:false, detached
// from the app lifetime. Reuses the code reader's route-file guard so the
// exact same path-safety chain gates every launch. Electron-free.
import { spawn as nodeSpawn } from "node:child_process";
import { CodeIpcChannels, type ExternalEditorOpenRequest, type ExternalEditorOpenResponse } from "../shared/codeIpc";
import { assertRouteFile } from "./codeReader";

/** Minimal detached-child surface (fake-able in tests). */
export interface EditorProcess {
  on(event: "error", cb: (error: Error) => void): this;
  on(event: "spawn", cb: () => void): this;
  kill(): void;
  unref?(): void;
}

export type EditorSpawn = (
  file: string,
  args: string[],
  options: { detached: true; shell: false; stdio: "ignore" },
) => EditorProcess;

export interface ExternalEditorDeps {
  /** Authoritative route root from the task runtime bridge's route handle. */
  resolveRouteRoot(taskId: string, routeId: string): string | undefined;
  /** User-configured editor command (settings.externalEditorCommand). */
  getEditorCommand(): string | undefined;
  /** Spawn override (tests); defaults to node:child_process spawn. */
  spawn?: EditorSpawn;
}

export interface ExternalEditorService {
  open(request: ExternalEditorOpenRequest): Promise<ExternalEditorOpenResponse>;
}

/** Splits a command spec into (executable, leading args) without a shell. */
export function parseEditorCommand(spec: string): { file: string; args: string[] } {
  const trimmed = spec.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 1) {
      const file = trimmed.slice(1, end);
      const rest = trimmed.slice(end + 1).trim();
      return { file, args: rest === "" ? [] : rest.split(/\s+/) };
    }
  }
  const [file, ...args] = trimmed.split(/\s+/);
  return { file, args };
}

/** Real spawner (node built-in, no electron): detached, stdio ignored. */
function defaultSpawn(file: string, args: string[], options: { detached: true; shell: false; stdio: "ignore" }): EditorProcess {
  return nodeSpawn(file, args, options) as unknown as EditorProcess;
}

export function createExternalEditor(deps: ExternalEditorDeps): ExternalEditorService {
  const spawnEditor = deps.spawn ?? defaultSpawn;

  return {
    async open(request): Promise<ExternalEditorOpenResponse> {
      const command = deps.getEditorCommand()?.trim();
      if (!command) {
        throw new Error("external editor: editor command is not configured (settings.externalEditorCommand)");
      }
      const root = deps.resolveRouteRoot(request.taskId, request.routeId);
      if (!root) {
        throw new Error(`external editor: unknown task/route: ${request.taskId}/${request.routeId}`);
      }
      const { absolute } = await assertRouteFile(root, request.relativePath);
      const { line, column } = request;
      if (
        (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) ||
        (column !== undefined && (!Number.isSafeInteger(column) || column < 1))
      ) {
        throw new Error("external editor: line/column must be positive integers");
      }

      const { file, args: leading } = parseEditorCommand(command);
      // path:line:column — the generic convention shared by VS Code / Cursor /
      // Sublime style CLIs; without a line the bare path is passed.
      const target =
        line === undefined ? absolute : `${absolute}:${line}${column === undefined ? "" : `:${column}`}`;

      const child = spawnEditor(file, [...leading, target], { detached: true, shell: false, stdio: "ignore" });
      child.unref?.();
      return await new Promise<ExternalEditorOpenResponse>((resolve) => {
        child.on("error", (error: NodeJS.ErrnoException) => {
          resolve({ launched: false, error: error.message });
        });
        // "spawn" fires when the process actually started — that is the
        // launch signal; the editor's later exit code is not our concern.
        child.on("spawn", () => resolve({ launched: true }));
      });
    },
  };
}

/** Registers the ipcMain handler (Electron host composition only). */
export async function registerExternalEditorIpc(service: ExternalEditorService): Promise<void> {
  const { ipcMain } = await import("electron");
  ipcMain.handle(CodeIpcChannels.codeOpenExternalEditor, (_e, req) => service.open(req));
}
