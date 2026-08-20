// TaskCommandService (Task 12 composition) — the bridge-backed TaskCommandPort
// wired into TaskIpcHandlers. Electron-free by construction: it depends only
// on the TaskRuntimeBridge (event log + route handles) and the git adapter.
//
// Scope honesty: operations whose semantics belong to the full command
// service (hunk derivation from checkpoints, apply/apply-journal flows,
// turn editing) throw TaskCommandNotSupportedError instead of fabricating
// data — Task 13 formalizes them. Everything implemented here reads and
// mutates the REAL task state:
//   - listRoutes/switchRoute: reduced route DAG with real forkTurnId +
//     workspaceKind (the enriched TaskRouteSummary DTO — no renderer-side
//     fabrication).
//   - forkRoute: the bridge's createForkedTaskRoute.
//   - changeTaskStatus/appendEvent: appends through the task's live port
//     (task lease + workspace lease, the fixed mutation contexts).
//   - recoverTask: the bridge's restart recovery (worktree replay).
//   - resolveGitBranch: git detect over the route workspace (null = unknown,
//     the TitleBar chip hides — never a fabricated "not a git repo").
import {
  reduceTask,
  taskStatusEvent,
  type TaskEvent,
  type TaskState,
  type TaskStatus,
} from "@innocencecode/task-core";
import { createGitAdapter, type GitAdapter } from "@innocencecode/task-git";
import type { TaskRuntimeBridge } from "./taskRuntimeBridge";
import type { TaskCommandPort } from "./taskIpcHandlers";
import type {
  TaskGetResponse,
  TaskRouteSummary,
} from "../shared/taskIpc";

/** Thrown for command-surface entries that land with Task 13. */
export class TaskCommandNotSupportedError extends Error {
  constructor(operation: string) {
    super(`task command service: ${operation} is not implemented yet (Task 13 command service)`);
    this.name = "TaskCommandNotSupportedError";
  }
}

const TASK_STATUSES = new Set<string>([
  "ready",
  "running",
  "review",
  "paused",
  "completed",
  "interrupted",
  "checkpoint-failed",
] satisfies TaskStatus[]);

export interface TaskCommandServiceDeps {
  bridge: TaskRuntimeBridge;
  /** Git adapter; defaults to the real task-git CLI adapter. */
  git?: GitAdapter;
  log?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
}

export interface TaskCommandService extends TaskCommandPort {
  /** Real branch of the task's active workspace; null when unknown/detached. */
  resolveGitBranch(taskId: string): Promise<string | null>;
}

function toSummary(state: TaskState, route: { routeId: string; parentRouteId: string | null; forkTurnId: string | null; checkpointId: string }): TaskRouteSummary {
  return {
    routeId: route.routeId,
    parentRouteId: route.parentRouteId,
    forkTurnId: route.forkTurnId,
    checkpointId: route.checkpointId,
    workspaceKind: state.workspaceKind,
  };
}

export function createTaskCommandService(deps: TaskCommandServiceDeps): TaskCommandService {
  const git = deps.git ?? createGitAdapter();
  const log = deps.log ?? (() => {});

  async function stateOf(taskId: string): Promise<TaskState> {
    return reduceTask(await deps.bridge.listEvents(taskId));
  }

  /** Appends one event through the live task port (lease-gated mutation).
   *  The execution scope labels the non-tool caller for the lease record. */
  async function appendThroughPort(taskId: string, event: TaskEvent): Promise<void> {
    const handle = deps.bridge.get(taskId);
    if (!handle) throw new Error(`task command service: task not live: ${taskId}`);
    const context = await handle.port.acquireMutationContext({
      taskId,
      routeId: handle.routeId,
      invocationId: "task-command-service",
      toolName: "taskCommand",
    });
    try {
      await handle.port.append(context, event);
    } finally {
      await context[Symbol.asyncDispose]();
    }
  }

  return {
    async listRoutes(taskId) {
      const state = await stateOf(taskId);
      return [...state.routes.values()].map((route) => toSummary(state, route));
    },

    async switchRoute(taskId, routeId) {
      const state = await stateOf(taskId);
      const route = state.routes.get(routeId);
      if (!route) throw new Error(`route not found: ${routeId} in task ${taskId}`);
      // NOTE: the persisted active-route transition rides Task 13's event
      // vocabulary (routeAttached only ever ADDS a route). The response is
      // the real route summary; the renderer's view state follows it.
      return toSummary(state, route);
    },

    async forkRoute(request) {
      const route = await deps.bridge.forkRoute(request);
      const state = await stateOf(request.taskId);
      return { ...toSummary(state, route), prompt: route.prompt };
    },

    async changeTaskStatus(taskId, status) {
      if (!TASK_STATUSES.has(status)) {
        throw new Error(`task command service: unknown task status: ${JSON.stringify(status)}`);
      }
      await appendThroughPort(taskId, taskStatusEvent({ status: status as TaskStatus }));
    },

    async recoverTask(taskId): Promise<TaskGetResponse> {
      const state = await deps.bridge.recoverTask(taskId);
      return {
        taskId: state.taskId,
        sessionId: state.sessionId,
        status: state.status,
        activeRouteId: state.activeRouteId,
        mode: state.mode,
        workspaceKind: state.workspaceKind,
        version: state.lastCommittedEventId ?? undefined,
        gitBranch: null,
      };
    },

    async resolveGitBranch(taskId) {
      const handle = deps.bridge.get(taskId);
      if (!handle) return null;
      try {
        const info = await git.detect(handle.workspaceRoot);
        return info.branch ?? null;
      } catch (error) {
        log("warn", "task branch detection failed", String(error));
        return null;
      }
    },

    async getHunks() {
      throw new TaskCommandNotSupportedError("getHunks");
    },
    async reviewHunk() {
      throw new TaskCommandNotSupportedError("reviewHunk");
    },
    async applyAccepted() {
      throw new TaskCommandNotSupportedError("applyAccepted");
    },
    async preflightApply() {
      throw new TaskCommandNotSupportedError("preflightApply");
    },
    async resolveConflict() {
      throw new TaskCommandNotSupportedError("resolveConflict");
    },
    async editUserMessage() {
      throw new TaskCommandNotSupportedError("editUserMessage");
    },
    async retryAssistant() {
      throw new TaskCommandNotSupportedError("retryAssistant");
    },
    async createCheckpoint() {
      throw new TaskCommandNotSupportedError("createCheckpoint");
    },
    async validate() {
      throw new TaskCommandNotSupportedError("validate");
    },
    async appendEvent(taskId, event) {
      await appendThroughPort(taskId, event);
    },
  };
}
