// Task runtime IPC composition (Task 12) — the host wiring that Task 7-11
// exported but never composed. Electron-free by construction: every
// registration function dynamically imports Electron (same pattern as
// terminalIpc.ts) and the renderer push port is injected. index.ts calls
// wireTaskRuntimeIpc() after the harness/bridge init and then runs
// recoverPersistedTaskRuntimes() once the renderer mounted its
// subscriptions (notices pushed earlier would be lost).
//
// Composed here:
//   - TaskIpcHandlers over the bridge-backed TaskCommandService (real
//     route summaries incl. forkTurnId/workspaceKind, real git branch)
//   - route-scoped code reader / search / external editor IPC
//   - bridge task events -> task:event broadcast (feeds useWorkbenchState)
//   - startup restart recovery: event-log replay notices (truncated tail /
//     replay failure) and worktree recovery with its retry command
import fs from "node:fs/promises";
import path from "node:path";
import type { TaskEvent as CoreTaskEvent } from "@innocencecode/task-core";
import { openTaskRepository, type TaskRepository } from "@innocencecode/task-workspace";
import type { TaskRuntimeBridge } from "./taskRuntimeBridge";
import { TaskIpcHandlers } from "./taskIpcHandlers";
import { createTaskCommandService } from "./taskCommandService";
import { createCodeReader, registerCodeReaderIpc } from "./codeReader";
import { createCodeSearch, registerCodeSearchIpc } from "./codeSearch";
import { createExternalEditor, registerExternalEditorIpc } from "./externalEditor";
import type { TaskUiEvent, TaskUiNotice } from "../shared/taskIpc";

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface TaskRuntimeIpcDeps {
  bridge: TaskRuntimeBridge;
  /** Private task storage base (userData/tasks in the host; temp in tests). */
  taskStorageDir: string;
  /** Authoritative route root from the bridge's route handle. */
  resolveRouteRoot(taskId: string, routeId: string): string | undefined;
  /** User-configured external editor command ("" = not configured). */
  getEditorCommand(): string;
  /** Renderer push port (webContents.send wrapper for the main window). */
  send(channel: string, payload: unknown): void;
  log?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
}

/** Route of a core task event; task-level events fall back to the live handle. */
function routeIdOf(event: CoreTaskEvent, fallback: string): string {
  switch (event.type) {
    case "taskCreated":
      return event.routeId;
    case "routeAttached":
      return event.route.routeId;
    case "turnPrepared":
    case "turnCommitted":
      return event.routeId;
    case "turnCheckpointed":
      return event.routeId ?? fallback;
    default:
      return fallback;
  }
}

/** Core event -> renderer push DTO (ids + status/route payloads only). */
export function toTaskUiEvent(
  bridge: TaskRuntimeBridge,
  notification: { taskId: string; event: CoreTaskEvent },
): TaskUiEvent {
  const handle = bridge.get(notification.taskId);
  const event = notification.event;
  return {
    taskId: notification.taskId,
    sessionId: event.type === "taskCreated" ? event.sessionId : handle?.sessionId ?? "",
    routeId: routeIdOf(event, handle?.routeId ?? "main"),
    kind: event.type,
    version: event.eventId,
    ...(event.type === "taskStatus" ? { status: event.status } : {}),
    ...(event.type === "routeAttached"
      ? {
          route: {
            routeId: event.route.routeId,
            parentRouteId: event.route.parentRouteId,
            forkTurnId: event.route.forkTurnId,
            checkpointId: event.route.checkpointId,
            workspaceKind: handle?.workspaceKind ?? "snapshot",
          },
        }
      : {}),
  };
}

/** Wires every task-runtime IPC surface. Call once after bridge init. */
export async function wireTaskRuntimeIpc(deps: TaskRuntimeIpcDeps): Promise<void> {
  const log = deps.log ?? (() => {});
  const commandService = createTaskCommandService({ bridge: deps.bridge, log });

  const handlers = new TaskIpcHandlers({
    bridge: deps.bridge,
    commandPort: commandService,
    resolveGitBranch: (taskId) => commandService.resolveGitBranch(taskId),
  });
  const { registerTaskIpcHandlers } = await import("./ipc");
  registerTaskIpcHandlers(handlers);

  // Route-scoped read surfaces (Task 11): the reader/searcher/editor all
  // resolve the route root through the bridge — ids only from the renderer.
  const codeReader = createCodeReader({ resolveRouteRoot: deps.resolveRouteRoot });
  const codeSearch = createCodeSearch({ resolveRouteRoot: deps.resolveRouteRoot });
  const externalEditor = createExternalEditor({
    resolveRouteRoot: deps.resolveRouteRoot,
    getEditorCommand: () => {
      const command = deps.getEditorCommand();
      return command === "" ? undefined : command;
    },
  });
  await registerCodeReaderIpc(codeReader);
  await registerCodeSearchIpc(codeSearch);
  await registerExternalEditorIpc(externalEditor);

  // Task events -> renderer broadcast (feeds useWorkbenchState; the reducer
  // parks events for inactive routes / foreign sessions).
  deps.bridge.onTaskEvent((notification) => {
    deps.send("task:event", toTaskUiEvent(deps.bridge, notification));
  });
}

/**
 * Startup restart recovery. For every persisted task directory:
 *   1. Replay the event log — a truncated tail yields an
 *      inconsistencyRecovered notice (state recovered from the last complete
 *      event); a replay failure yields eventRecoveryFailed (write gate).
 *   2. Git tasks re-enter the bridge's recoverTask (worktree replay) — a
 *      failure yields a worktreeFailed notice carrying the retry command
 *      (task:recover); success with warnings yields restartRecovered.
 */
export async function recoverPersistedTaskRuntimes(deps: TaskRuntimeIpcDeps): Promise<void> {
  const log = deps.log ?? (() => {});
  // Layout: <base>/tasks/<taskId>/events.jsonl (taskStorageDir is the base).
  const tasksRoot = path.join(deps.taskStorageDir, "tasks");
  const entries = await fs.readdir(tasksRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !TASK_ID_PATTERN.test(entry.name)) continue;
    const taskId = entry.name;

    let truncatedTail = false;
    let repository: TaskRepository | null = null;
    let recovered:
      | { sessionId: string; activeRouteId: string; lastCommittedEventId: string | null; workspaceKind: string }
      | null = null;
    try {
      repository = await openTaskRepository(deps.taskStorageDir, taskId);
      const result = await repository.recoverEventLog();
      if (result === null) continue; // log does not exist yet: never started
      truncatedTail = result.truncatedTail;
      recovered = {
        sessionId: result.sessionId,
        activeRouteId: result.activeRouteId,
        lastCommittedEventId: result.lastCommittedEventId,
        workspaceKind: result.workspaceKind,
      };
      if (truncatedTail) {
        const notice: TaskUiNotice = {
          type: "inconsistencyRecovered",
          taskId,
          sessionId: result.sessionId,
          routeId: result.activeRouteId,
          message: "event log had a truncated tail",
          recoveredFromEventId: result.lastCommittedEventId ?? "",
        };
        deps.send("task:notice", notice);
      }
    } catch (error) {
      log("error", "task event recovery failed", { taskId, error: String(error) });
      // The log itself is unreadable — attribute the notice through the
      // persisted head when possible so the OWNING session's workbench can
      // consume it ("" = unattributable; the renderer's session filter then
      // ignores it instead of leaking it into an unrelated session).
      const head = repository !== null ? await repository.readTaskHead().catch(() => null) : null;
      deps.send("task:notice", {
        type: "eventRecoveryFailed",
        taskId,
        sessionId: head?.sessionId ?? "",
        routeId: head?.activeRouteId ?? "main",
        message: String(error),
      } satisfies TaskUiNotice);
      continue;
    }

    if (!recovered || recovered.workspaceKind !== "git") continue; // snapshot tasks have no worktree to recover
    try {
      const state = await deps.bridge.recoverTask(taskId);
      const warnings: string[] = [];
      for (const turn of state.turns.values()) {
        if (turn.phase === "prepared") warnings.push(`turn ${turn.turnId} is prepared but not committed`);
      }
      if (warnings.length > 0) {
        deps.send("task:notice", {
          type: "restartRecovered",
          taskId,
          sessionId: state.sessionId,
          routeId: state.activeRouteId,
          warnings,
        } satisfies TaskUiNotice);
      }
    } catch (error) {
      log("warn", "task worktree recovery failed", { taskId, error: String(error) });
      deps.send("task:notice", {
        type: "worktreeFailed",
        taskId,
        sessionId: recovered.sessionId,
        routeId: recovered.activeRouteId,
        message: String(error),
        retry: { taskId, sessionId: recovered.sessionId, routeId: recovered.activeRouteId, mode: "isolated" },
      } satisfies TaskUiNotice);
    }
  }
}
