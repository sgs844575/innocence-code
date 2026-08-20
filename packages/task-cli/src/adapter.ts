/**
 * Task CLI adapter (Task 13): a thin, Electron-free delegation surface over
 * task-core's TaskCommandService. The adapter NEVER touches task storage
 * directly — every command delegates to the runtime's service — and all
 * rendered output flows through the injected output port (never stdout).
 */
import type {
  Checkpoint,
  Hunk,
  TaskApplyConflict,
  TaskFilePatch,
  TaskForkCommand,
  TaskGetResult,
  TaskRouteSummaryDto,
  TaskStartedInfo,
  TaskValidationResult,
} from "@innocencecode/task-core";
import type { TaskCliRuntime } from "./runtime";
import {
  renderChanges,
  renderConflicts,
  renderHunks,
  renderRoutes,
  renderTaskSummary,
  renderWarnings,
  type TaskCliOutputLine,
} from "./review-renderer";

export type { TaskCliOutputLine };

/** Output port: the adapter's ONLY way to emit rendered text. */
export interface TaskCliOutput {
  write(chunk: string | TaskCliOutputLine): void;
}

/** Structured collector for tests and embedding hosts. */
export function collectStructuredOutput(): TaskCliOutput & { lines: (string | TaskCliOutputLine)[] } {
  const lines: (string | TaskCliOutputLine)[] = [];
  return {
    lines,
    write(chunk) {
      lines.push(chunk);
    },
  };
}

/** Fork result: the new route summary (worktree path included) + its prompt. */
export interface TaskCliForkResult {
  route: TaskRouteSummaryDto & { workspaceRoot?: string };
  prompt: string;
}

export interface TaskCliAdapter {
  start(request: { workspaceRoot: string; mode: "baseline" | "isolated"; sessionId?: string; taskId?: string }): Promise<TaskStartedInfo>;
  getTask(taskId: string): Promise<TaskGetResult>;
  getChanges(taskId: string, routeId: string): Promise<TaskFilePatch[]>;
  getCheckpoint(taskId: string, checkpointId: string): Promise<Checkpoint | null>;
  listRoutes(taskId: string): Promise<TaskRouteSummaryDto[]>;
  switchRoute(taskId: string, routeId: string): Promise<TaskRouteSummaryDto>;
  forkFromUser(request: TaskForkCommand & { editedText: string }): Promise<TaskCliForkResult>;
  retryAssistant(request: TaskForkCommand): Promise<TaskCliForkResult>;
  listHunks(taskId: string, routeId: string): Promise<Hunk[]>;
  review(request: {
    taskId: string;
    routeId: string;
    hunkRef: string;
    status: "accepted" | "restored";
    /** Omitted = the current version is resolved first (single-user CLI flow). */
    expectedVersion?: string;
  }): Promise<void>;
  restore(request: { taskId: string; routeId: string; hunkRef: string; expectedVersion: string }): Promise<void>;
  attributeUnknown(taskId: string, path: string, attribution: "task-owned" | "external"): Promise<void>;
  resolveConflict(request: {
    taskId: string;
    routeId: string;
    path: string;
    attribution: "task-owned" | "external";
  }): Promise<void>;
  validate(taskId: string, routeId: string): Promise<TaskValidationResult>;
  complete(request: { taskId: string; confirmValidationFailure: boolean }): Promise<void>;
  applyAccepted(taskId: string, routeId: string): Promise<{ applied: string[]; conflicts: TaskApplyConflict[] }>;
  recover(taskId: string): Promise<TaskGetResult>;
  delete(taskId: string): Promise<void>;
  recoveryWarnings(taskId: string): Promise<string[]>;

  // -- Rendering (structured lines through the output port) -----------------
  renderTask(taskId: string): Promise<TaskCliOutputLine[]>;
  renderReview(taskId: string, routeId: string): Promise<TaskCliOutputLine[]>;
  renderRouteList(taskId: string): Promise<TaskCliOutputLine[]>;
}

export interface TaskCliAdapterDeps {
  taskRuntime: TaskCliRuntime;
  output: TaskCliOutput;
}

export function createTaskCliAdapter(deps: TaskCliAdapterDeps): TaskCliAdapter {
  const service = deps.taskRuntime.service;
  const emit = (lines: readonly TaskCliOutputLine[]): TaskCliOutputLine[] => {
    for (const rendered of lines) deps.output.write(rendered);
    return [...lines];
  };

  return {
    start: (request) => service.start(request),
    getTask: (taskId) => service.get(taskId),
    getChanges: (taskId, routeId) => service.getChanges(taskId, routeId),
    getCheckpoint: (taskId, checkpointId) => service.getCheckpoint(taskId, checkpointId),
    listRoutes: (taskId) => service.listRoutes(taskId),
    switchRoute: (taskId, routeId) => service.switchRoute(taskId, routeId),
    forkFromUser: (request) => service.forkFromUser(request),
    retryAssistant: (request) => service.retryAssistant(request),
    listHunks: (taskId, routeId) => service.listHunks(taskId, routeId),
    async review(request) {
      const expectedVersion = request.expectedVersion ?? (await service.get(request.taskId)).version ?? "";
      await service.review({ ...request, expectedVersion });
    },
    restore: (request) => service.restore(request),
    attributeUnknown: (taskId, path, attribution) => service.attributeUnknown(taskId, path, attribution),
    resolveConflict: (request) => service.resolveConflict(request),
    validate: (taskId, routeId) => service.validate(taskId, routeId),
    complete: (request) => service.complete(request),
    applyAccepted: (taskId, routeId) => service.applyAccepted(taskId, routeId),
    recover: (taskId) => service.recover(taskId),
    delete: (taskId) => service.delete(taskId),
    recoveryWarnings: (taskId) => service.recoveryWarnings(taskId),

    async renderTask(taskId) {
      return emit(renderTaskSummary(await service.get(taskId)));
    },
    async renderReview(taskId, routeId) {
      const hunks = await service.listHunks(taskId, routeId);
      const changes = await service.getChanges(taskId, routeId);
      return emit([...renderChanges(changes), ...renderHunks(hunks)]);
    },
    async renderRouteList(taskId) {
      return emit(renderRoutes(await service.listRoutes(taskId)));
    },
  };
}

export { renderChanges, renderConflicts, renderHunks, renderRoutes, renderTaskSummary, renderWarnings };
