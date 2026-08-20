// Electron command service (Task 12 composition, repointed in Task 13): a
// thin adapter that wires the bridge's resources (live task storage, locks,
// fork/recover/delete lifecycle) into task-core's ONE host-agnostic
// TaskCommandService and maps its surface onto the TaskCommandPort the IPC
// handlers delegate to. All command semantics — mutation leases (task →
// workspace order), expectedVersion CAS, review/apply/completion gates —
// live INSIDE the task-core service; this module contains only host glue.
import path from "node:path";
import {
  createTaskCommandService as createCoreService,
  TaskCommandError,
  type TaskCommandDeps,
  type TaskCommandService as CoreTaskCommandService,
  type TaskEvent,
  type TaskRouteSummaryDto,
} from "@innocencecode/task-core";
import { foldAttributionDecisions } from "@innocencecode/plugin-task";
import {
  createGitAdapter,
  GitWorkspaceError,
  type GitAdapter,
  type GitBaseline,
  type WorktreeLease,
} from "@innocencecode/task-git";
import {
  canonicalWorkspaceKey,
  createTaskMutationLock,
  createWorkspaceWriteLock,
  diffCheckpointToWorkspace,
  diskHash,
  openTaskRepository,
  readWorkspaceBytes,
  scanWorkspace,
  type TaskRepository,
  type WorkspaceSnapshot,
} from "@innocencecode/task-workspace";
import type { TaskRuntimeBridge } from "./taskRuntimeBridge";
import type { TaskCommandPort } from "./taskIpcHandlers";
import type { TaskApplyResponse, TaskGetResponse, TaskRouteSummary } from "../shared/taskIpc";

export { TaskCommandError };

export interface TaskCommandServiceDeps {
  bridge: TaskRuntimeBridge;
  /** Private task storage base (userData/tasks in the host). */
  taskStorageDir: string;
  git?: GitAdapter;
  /** Forwards service-appended events to the renderer push port. */
  onEvent?: (taskId: string, event: TaskEvent) => void;
  log?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
}

export interface TaskCommandService extends TaskCommandPort {
  /** Real branch of the task's active workspace; null when unknown/detached. */
  resolveGitBranch(taskId: string): Promise<string | null>;
}

/** Maps a service route summary onto the renderer DTO shape. */
function toRouteSummary(summary: TaskRouteSummaryDto): TaskRouteSummary {
  return { ...summary };
}

export function createTaskCommandService(deps: TaskCommandServiceDeps): TaskCommandService {
  const git = deps.git ?? createGitAdapter();
  const log = deps.log ?? (() => {});
  const storageDir = path.resolve(deps.taskStorageDir);
  const repositories = new Map<string, TaskRepository>();

  const repoOf = async (taskId: string): Promise<TaskRepository> => {
    const cached = repositories.get(taskId);
    if (cached) return cached;
    const repository = await openTaskRepository(storageDir, taskId);
    repositories.set(taskId, repository);
    return repository;
  };

  /** Live sessionId for ownership checks the service enforces. */
  const sessionIdOf = (taskId: string): string => {
    const handle = deps.bridge.get(taskId);
    if (!handle) throw new TaskCommandError("task-not-found", `task not live: ${taskId}`);
    return handle.sessionId;
  };

  const ports: TaskCommandDeps = {
    store: {
      listEvents: async (taskId) => (await repoOf(taskId)).list(),
      appendEvents: async (taskId, events) => {
        await (await repoOf(taskId)).append(events);
      },
      readTaskHead: async (taskId) => (await repoOf(taskId)).readTaskHead(),
      writeTaskHead: async (taskId, head) => {
        await (await repoOf(taskId)).writeTaskHead(head);
      },
      readCheckpoint: async (taskId, checkpointId) => (await repoOf(taskId)).readCheckpoint(checkpointId),
      writeCheckpoint: async (taskId, checkpoint) => {
        await (await repoOf(taskId)).writeCheckpoint(checkpoint);
      },
      putObject: async (taskId, bytes) => (await (await repoOf(taskId)).objects.put(bytes)).key,
      getObject: async (taskId, hash) => (await repoOf(taskId)).objects.get(hash),
      writeArtifact: async (taskId, name, data) => {
        await (await repoOf(taskId)).storage.storage.writeFileAtomic(name, data);
      },
      readArtifact: async (taskId, name) => {
        try {
          return await (await repoOf(taskId)).storage.storage.readTextFile(name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
    },
    locks: {
      // Same lock files the live ports take: cross-process file leases over
      // the shared base storage — the service never mutates unleased.
      acquireTaskLease: async (taskId, owner, signal) =>
        createTaskMutationLock((await repoOf(taskId)).storage.locksStorage).acquire(taskId, owner, signal),
      acquireWorkspaceLease: async (workspaceKey, owner, signal) =>
        createWorkspaceWriteLock((await repoOf("locks")).storage.locksStorage).acquire(workspaceKey, owner, signal),
    },
    workspace: {
      canonicalKey: (root) => canonicalWorkspaceKey(root),
      scan: async (root): Promise<WorkspaceSnapshot> => scanWorkspace(root),
      hash: (root, relativePath) => diskHash(root, relativePath),
      read: (root, relativePath) => readWorkspaceBytes(root, relativePath),
    },
    git: {
      detect: async (root) => {
        try {
          const info = await git.detect(root);
          return { isRepo: true, root: info.root, branch: info.branch ?? null };
        } catch (error) {
          if (error instanceof GitWorkspaceError) {
            return { isRepo: false, root: path.resolve(root), branch: null };
          }
          throw error;
        }
      },
      captureBaseline: (root) => git.captureBaseline(root),
      createWorktree: async (input) => {
        const lease = await git.createWorktree(input);
        return { path: lease.path, lease };
      },
      overlayBaseline: (lease, baseline) => git.overlayBaseline(lease as WorktreeLease, baseline as GitBaseline),
      recoverWorktree: async (input) => {
        const lease = await git.recoverWorktree({
          root: input.root,
          path: input.path,
          baseCommit: input.baseCommit,
          baseline: input.baseline as GitBaseline,
          checkpointFiles: input.checkpointFiles,
          readContent: input.readContent,
        });
        return { path: lease.path, lease };
      },
      destroyWorktree: (lease) => git.destroyWorktree(lease as WorktreeLease),
      closeLease: (lease) => git.closeLease(lease as WorktreeLease),
      preflightApply: (input) => git.preflightApply(input),
      applyAccepted: (input) => git.applyAccepted(input),
    },
    diff: { diff: (input) => diffCheckpointToWorkspace(input) },
    attribution: { decisions: foldAttributionDecisions },
    fork: {
      // The bridge owns the live fork (worktree + watcher + port wiring).
      createForkedRoute: async (input) => {
        const route = await deps.bridge.forkRoute({
          sessionId: input.request.sessionId,
          taskId: input.taskId,
          sourceRouteId: input.request.sourceRouteId,
          sourceTurnId: input.request.sourceTurnId,
          mode: input.mode,
          editedText: input.request.editedText,
          routeName: input.request.routeName,
        });
        return { route, prompt: route.prompt };
      },
    },
    recover: { recoverTask: (taskId) => deps.bridge.recoverTask(taskId) },
    delete: { deleteTask: (taskId) => deps.bridge.deleteTask(taskId) },
    worktreeDir: path.join(storageDir, "worktrees"),
    onEvent: deps.onEvent,
    log,
  };

  const service: CoreTaskCommandService = createCoreService(ports);

  return {
    getHunks: (taskId, routeId) => service.listHunks(taskId, routeId),
    listRoutes: async (taskId) => (await service.listRoutes(taskId)).map(toRouteSummary),
    switchRoute: async (taskId, routeId) => toRouteSummary(await service.switchRoute(taskId, routeId)),
    forkRoute: async (request) => {
      const result = request.mode === "edit-user"
        ? await service.forkFromUser({ ...request, editedText: request.editedText ?? "" })
        : await service.retryAssistant(request);
      return { ...toRouteSummary(result.route), workspaceRoot: result.route.workspaceRoot, prompt: result.prompt };
    },
    reviewHunk: (taskId, routeId, hunkRef, status, expectedVersion) =>
      service.review({ taskId, routeId, hunkRef, status, expectedVersion }),
    restoreHunk: async (taskId, routeId, hunkRef, expectedVersion) => {
      // Renderer-supplied token wins (CAS); callers without one fall back to
      // the fresh version (pre-existing no-CAS behavior for host-internal uses).
      const version = expectedVersion ?? (await service.get(taskId)).version ?? "";
      await service.restore({ taskId, routeId, hunkRef, expectedVersion: version });
    },
    applyAccepted: async (taskId, routeId) => {
      const result = await service.applyAccepted(taskId, routeId);
      return {
        applied: result.applied,
        conflicts: result.conflicts.map((conflict) => ({
          path: conflict.path,
          reason: `expected ${conflict.expected ?? "-"}, found ${conflict.actual ?? "-"}`,
        })),
      };
    },
    preflightApply: async (taskId, routeId) => {
      const report = await service.applyAccepted(taskId, routeId, { dryRun: true });
      if (report.conflicts.length === 0) return { status: "clean" as const };
      return {
        status: "conflict" as const,
        conflicts: report.conflicts.map((conflict) => ({
          path: conflict.path,
          reason: `expected ${conflict.expected ?? "-"}, found ${conflict.actual ?? "-"}`,
        })),
      };
    },
    resolveConflict: (taskId, routeId, pathName, attribution) =>
      service.resolveConflict({ taskId, routeId, path: pathName, attribution }),
    editUserMessage: async (taskId, routeId, turnId, text) => {
      const result = await service.forkFromUser({
        sessionId: sessionIdOf(taskId),
        taskId,
        sourceRouteId: routeId,
        sourceTurnId: turnId,
        mode: "edit-user",
        editedText: text,
        routeName: `Edit ${turnId}`,
      });
      return { turnId, routeId: result.route.routeId };
    },
    retryAssistant: async (taskId, routeId, turnId) => {
      const result = await service.retryAssistant({
        sessionId: sessionIdOf(taskId),
        taskId,
        sourceRouteId: routeId,
        sourceTurnId: turnId,
        mode: "retry-assistant",
        routeName: `Retry ${turnId}`,
      });
      return { turnId, routeId: result.route.routeId };
    },
    createCheckpoint: (taskId, routeId) => service.createCheckpoint(taskId, routeId),
    changeTaskStatus: (taskId, status) => service.changeStatus(taskId, status),
    complete: (request) => service.complete(request),
    validate: (taskId, routeId) => service.validate(taskId, routeId),
    recoverTask: async (taskId): Promise<TaskGetResponse> => {
      const recovered = await service.recover(taskId);
      return {
        taskId: recovered.taskId,
        sessionId: recovered.sessionId,
        status: recovered.status,
        activeRouteId: recovered.activeRouteId,
        mode: recovered.mode,
        workspaceKind: recovered.workspaceKind,
        version: recovered.version,
        gitBranch: null,
      };
    },
    appendEvent: (taskId, event) => service.append(taskId, event),

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
  };
}

export type { TaskApplyResponse };
