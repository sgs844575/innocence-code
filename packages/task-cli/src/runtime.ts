/**
 * Host-agnostic command runtime factory (Task 13): wires the REAL
 * implementations — @innocencecode/task-workspace (repository, CAS, file
 * locks, scanner, checkpoint diff), @innocencecode/task-git (worktrees,
 * baseline, apply) and @innocencecode/plugin-task (attribution fold) — into
 * task-core's TaskCommandService ports. The Electron host keeps its bridge
 * (taskRuntimeBridge.ts) with its own equivalent wiring plus watchers and
 * live ports; the deliberately small duplication (fork/recover/delete
 * orchestration without watchers) is the documented factory difference —
 * consolidating the two compositions is a follow-up once the bridge's live
 * runtime moves behind the same service.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { foldAttributionDecisions } from "@innocencecode/plugin-task";
import { openSecureStorage } from "@innocencecode/secure-storage-node";
import {
  createGitAdapter,
  GitWorkspaceError,
  type GitAdapter,
  type GitBaseline,
  type WorktreeLease,
} from "@innocencecode/task-git";
import {
  createTaskCommandService,
  reduceTask,
  toTaskHead,
  type Checkpoint,
  type Route,
  type TaskCommandDeps,
  type TaskCommandLocks,
  type TaskCommandService,
  type TaskEvent,
  type TaskStartedInfo,
  type TaskValidationResult,
} from "@innocencecode/task-core";
import {
  canonicalWorkspaceKey,
  createTaskMutationLock,
  createWorkspaceWriteLock,
  diffCheckpointToWorkspace,
  diskHash,
  openTaskRepository,
  readWorkspaceBytes,
  scanWorkspace,
  taskRootPath,
  type TaskRepository,
  type WorkspaceSnapshot,
} from "@innocencecode/task-workspace";

const LOCK_DIRS = ["locks", "locks/workspace", "locks/task"] as const;

export interface TaskCliRuntimeOptions {
  /** Private task storage base (tasks/, locks/ and worktrees live under it). */
  storageDir: string;
  git?: GitAdapter;
  worktreeDir?: string;
  /** Injected validator (gates completion); absent = validation passes. */
  validator?: (taskId: string, routeId: string, workspaceRoot: string) => Promise<TaskValidationResult>;
  /**
   * Agent-writer seam: invoked right after a task becomes durable. A real
   * host runs its agent here; tests simulate agent file writes.
   */
  agentWriter?: (task: TaskStartedInfo) => Promise<void>;
  /** Bounded lease wait for service mutations (default 30s). */
  lockTimeoutMs?: number;
  log?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
}

export interface TaskCliRuntime {
  /** The one host-agnostic command service (the adapter's only engine). */
  readonly service: TaskCommandService;
  /** The same lock pair every service mutation takes (ops/diagnostics seam). */
  readonly locks: TaskCommandLocks;
  readonly storageDir: string;
  /** Canonical workspace key of one route (the workspace lease identity). */
  canonicalRouteKey(taskId: string, routeId: string): Promise<string>;
}

export async function createTaskCliRuntime(options: TaskCliRuntimeOptions): Promise<TaskCliRuntime> {
  const storageDir = path.resolve(options.storageDir);
  const worktreeDir = options.worktreeDir ?? path.join(storageDir, "worktrees");
  const gitAdapter = options.git ?? createGitAdapter();
  const log = options.log ?? (() => {});
  const locksStorage = await openSecureStorage(storageDir, { dirs: [...LOCK_DIRS] });
  const repositories = new Map<string, TaskRepository>();
  const clock = { newId: (prefix?: string) => `${prefix}_${crypto.randomUUID()}`, now: () => new Date().toISOString() };

  const repoOf = async (taskId: string): Promise<TaskRepository> => {
    const cached = repositories.get(taskId);
    if (cached) return cached;
    const repository = await openTaskRepository(storageDir, taskId);
    repositories.set(taskId, repository);
    return repository;
  };

  const locks: TaskCommandLocks = {
    acquireTaskLease: (taskId, owner, signal) =>
      createTaskMutationLock(locksStorage).acquire(taskId, owner, signal),
    acquireWorkspaceLease: (workspaceKey, owner, signal) =>
      createWorkspaceWriteLock(locksStorage).acquire(workspaceKey, owner, signal),
  };

  async function baselineOf(taskId: string): Promise<GitBaseline | null> {
    const repository = await repoOf(taskId);
    const raw = await repository.storage.storage.readTextFile("baseline.json").catch(() => null);
    return raw === null ? null : (JSON.parse(raw) as GitBaseline);
  }

  const deps: TaskCommandDeps = {
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
      writeCheckpoint: async (taskId, checkpoint: Checkpoint) => {
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
    locks,
    workspace: {
      canonicalKey: (root) => canonicalWorkspaceKey(root),
      scan: async (root): Promise<WorkspaceSnapshot> => scanWorkspace(root),
      hash: (root, relativePath) => diskHash(root, relativePath),
      read: (root, relativePath) => readWorkspaceBytes(root, relativePath),
    },
    git: {
      detect: async (root) => {
        try {
          const info = await gitAdapter.detect(root);
          return { isRepo: true, root: info.root, branch: info.branch ?? null };
        } catch (error) {
          if (error instanceof GitWorkspaceError) {
            return { isRepo: false, root: path.resolve(root), branch: null };
          }
          throw error;
        }
      },
      captureBaseline: (root) => gitAdapter.captureBaseline(root),
      createWorktree: async (input) => {
        const lease = await gitAdapter.createWorktree(input);
        return { path: lease.path, lease };
      },
      overlayBaseline: (lease, baseline) =>
        gitAdapter.overlayBaseline(lease as WorktreeLease, baseline as GitBaseline),
      recoverWorktree: async (input) => {
        const lease = await gitAdapter.recoverWorktree({
          root: input.root,
          path: input.path,
          baseCommit: input.baseCommit,
          baseline: input.baseline as GitBaseline,
          checkpointFiles: input.checkpointFiles,
          readContent: input.readContent,
        });
        return { path: lease.path, lease };
      },
      destroyWorktree: (lease) => gitAdapter.destroyWorktree(lease as WorktreeLease),
      closeLease: (lease) => gitAdapter.closeLease(lease as WorktreeLease),
      preflightApply: (input) => gitAdapter.preflightApply(input),
      applyAccepted: (input) => gitAdapter.applyAccepted(input),
    },
    diff: { diff: (input) => diffCheckpointToWorkspace(input) },
    attribution: { decisions: foldAttributionDecisions },
    fork: {
      createForkedRoute: async (input) => {
        const repository = await repoOf(input.taskId);
        const baseline = await baselineOf(input.taskId);
        if (baseline === null) throw new Error("Git repository required for code-state fork");
        const source = input.state.routes.get(input.request.sourceRouteId);
        if (source === undefined || !source.baseCommit) {
          throw new Error("source route immutable baseCommit is missing");
        }
        const checkpoint = await repository.readCheckpoint(input.resolved.checkpointId);
        if (checkpoint === null) throw new Error(`checkpoint not found: ${input.resolved.checkpointId}`);

        const taskLease = await locks.acquireTaskLease(input.taskId, {
          taskId: input.taskId,
          routeId: input.request.sourceRouteId,
        });
        let worktree: { path: string; lease: unknown } | undefined;
        let restoreHead: (() => Promise<void>) | undefined;
        try {
          const routeId = clock.newId("route");
          const routePath = path.join(worktreeDir, input.taskId, routeId);
          worktree = await deps.git.createWorktree({
            root: baseline.root,
            path: routePath,
            baseCommit: source.baseCommit,
          });
          await deps.git.overlayBaseline(worktree.lease, baseline);
          const recovered = await deps.git.recoverWorktree({
            root: baseline.root,
            path: routePath,
            baseCommit: source.baseCommit,
            baseline,
            checkpointFiles: checkpoint.files.map((file) => ({ path: file.path, hash: file.hash })),
            readContent: (hash) => repository.objects.get(hash),
          });
          // Every target path/hash verified BEFORE the route becomes durable.
          for (const file of checkpoint.files) {
            const target = path.join(recovered.path, ...file.path.split("/"));
            if (file.hash === null) {
              await fs.access(target).then(
                () => {
                  throw new Error(`fork validation expected absent path: ${file.path}`);
                },
                (error: NodeJS.ErrnoException) => {
                  if (error.code !== "ENOENT") throw error;
                },
              );
            } else {
              const bytes = new Uint8Array(await fs.readFile(target));
              const stored = await repository.objects.get(file.hash);
              if (!Buffer.from(bytes).equals(Buffer.from(stored))) {
                throw new Error(`fork validation hash mismatch: ${file.path}`);
              }
            }
          }
          const route: Route = {
            routeId,
            parentRouteId: input.resolved.parentRouteId,
            forkTurnId: input.resolved.sourceTurnId,
            checkpointId: input.resolved.checkpointId,
            workspaceRoot: recovered.path,
            readonly: false,
            baseCommit: source.baseCommit,
          };
          const attached: TaskEvent = {
            type: "routeAttached",
            route,
            eventId: clock.newId("event"),
            at: clock.now(),
          };
          const beforeEvents = await repository.list();
          await repository.writeTaskHead(toTaskHead(reduceTask([...beforeEvents, attached])));
          restoreHead = () => repository.writeTaskHead(toTaskHead(input.state));
          await repository.append([attached]);
          restoreHead = undefined;
          return { route, prompt: input.resolved.prompt };
        } catch (error) {
          await restoreHead?.().catch(() => undefined);
          if (worktree !== undefined) {
            await deps.git.destroyWorktree(worktree.lease).catch(() => undefined);
          }
          throw error;
        } finally {
          await taskLease[Symbol.asyncDispose]();
        }
      },
    },
    recover: {
      recoverTask: async (taskId) => {
        const repository = await repoOf(taskId);
        // Interrupted multi-file applies first (same ordering as the Electron
        // bridge): roll back a partially applied user workspace before any
        // worktree replay reads disk state.
        const journalReport = await repository.recoverApplyJournals();
        if (journalReport.rolledBack.length > 0) {
          log("warn", "task interrupted apply rolled back", {
            taskId,
            transactionIds: journalReport.completed,
            paths: journalReport.rolledBack,
          });
        }
        const state = reduceTask(await repository.list());
        const baseline = await baselineOf(taskId);
        if (baseline === null) return state; // snapshot task: nothing to replay
        for (const route of state.routes.values()) {
          const checkpoint = await repository.readCheckpoint(route.checkpointId);
          if (checkpoint === null) throw new Error(`checkpoint not found: ${route.checkpointId}`);
          if (route.baseCommit && (route.parentRouteId !== null || state.mode === "isolated")) {
            await gitAdapter.recoverWorktree({
              root: baseline.root,
              path: route.workspaceRoot,
              baseCommit: route.baseCommit,
              baseline,
              checkpointFiles: checkpoint.files.map((file) => ({ path: file.path, hash: file.hash })),
              readContent: (hash) => repository.objects.get(hash),
            });
          }
        }
        return state;
      },
    },
    delete: {
      deleteTask: async (taskId) => {
        const repository = await repoOf(taskId);
        const events = await repository.list();
        if (events.length === 0) return;
        const state = reduceTask(events);
        const baseline = await baselineOf(taskId);
        if (baseline !== null) {
          for (const route of state.routes.values()) {
            if (!route.baseCommit || route.parentRouteId === null) continue;
            await gitAdapter.destroyWorktree({
              leaseId: `delete:${taskId}:${route.routeId}`,
              repoRoot: baseline.root,
              path: route.workspaceRoot,
              baseCommit: route.baseCommit,
            }).catch((error) => log("warn", "task worktree destroy failed", String(error)));
          }
          if (state.mode === "isolated" && typeof baseline.headCommit === "string") {
            const mainRoute = [...state.routes.values()].find((route) => route.parentRouteId === null);
            await gitAdapter.destroyWorktree({
              leaseId: `delete:${taskId}:main`,
              repoRoot: baseline.root,
              path: mainRoute?.workspaceRoot ?? path.join(worktreeDir, taskId),
              baseCommit: baseline.headCommit,
            }).catch((error) => log("warn", "task worktree destroy failed", String(error)));
          }
        }
        await fs.rm(taskRootPath(storageDir, taskId), { recursive: true, force: true });
        repositories.delete(taskId);
      },
    },
    validator: options.validator,
    worktreeDir,
    lockTimeoutMs: options.lockTimeoutMs,
    onTaskStarted: options.agentWriter,
    log,
  };

  const service = createTaskCommandService(deps);

  return {
    service,
    locks,
    storageDir,
    async canonicalRouteKey(taskId, routeId) {
      const state = reduceTask(await (await repoOf(taskId)).list());
      const route = state.routes.get(routeId);
      if (route === undefined) throw new Error(`route not found: ${routeId} in task ${taskId}`);
      return canonicalWorkspaceKey(route.workspaceRoot);
    },
  };
}
