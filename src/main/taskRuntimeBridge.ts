// Task runtime bridge: the host composition piece that opens tasks (baseline
// / isolated worktree modes over @innocencecode/task-git), captures the
// baseline BEFORE any agent run, builds each task's REAL TaskRuntimePort
// (taskPort.ts) over @innocencecode/task-workspace, injects plugin-task's
// capture middleware into route-scoped agent sessions and forwards task
// events to an injected emitter (Task 7 wires that to IPC — this module has
// no Electron/webContents surface by construction).
//
// PLUGIN EVENT STORAGE (Task-4 deferred obligation, resolved here): plugin
// events (changeRecorded/attribution*) are stored in the SAME events.jsonl as
// core task events — the types were moved into task-core's event union so
// reduceTask/recovery accept one single log (choice over a separate
// plugin-events section: one log, one recovery; see plugin-task/src/events.ts).
//
// RELEASE SEMANTICS: app quit / session teardown calls disposeAll() —
// watchers stop and worktree leases close WITHOUT destroying the worktrees
// (they must survive restarts; recovery replays them). destroyWorktree runs
// ONLY on explicit task deletion (deleteTask). AgentSessions are NOT held
// here — the HarnessRuntime's disposeAll owns them on the same quit path.
import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessPlugin } from "@innocencecode/harness-core";
import type { SessionToolIndex } from "@innocencecode/harness-electron";
import { taskPlugin, type TaskRuntimePort } from "@innocencecode/plugin-task";
import {
  reduceTask,
  taskCreatedEvent,
  toTaskHead,
  type Checkpoint,
  type TaskEvent as CoreTaskEvent,
  type TaskMode,
  type Route,
  type TaskState,
  type WorkspaceKind,
} from "@innocencecode/task-core";
import {
  createTaskMutationLock,
  createWorkspaceWatcher,
  createWorkspaceWriteLock,
  openTaskRepository,
  scanWorkspace,
  type TaskMutationLock,
  type TaskRepository,
  type WorkspaceWatcher,
  type WorkspaceWriteLock,
} from "@innocencecode/task-workspace";
import {
  createGitAdapter,
  GitWorkspaceError,
  type GitAdapter,
  type GitBaseline,
  type WorktreeLease,
} from "@innocencecode/task-git";
import { LiveTaskPort } from "./taskPort";
import { createForkedTaskRoute, type ForkRouteInput } from "./taskRouteFork";

export type { TaskRuntimePort };

export interface TaskStartRequest {
  /** Chat session the task belongs to (persisted on the taskCreated event). */
  sessionId?: string;
  /** Minted when omitted; validated as a single safe storage directory segment. */
  taskId?: string;
  /** Main route id of the task; defaults to "main". */
  routeId?: string;
  /** Authoritative per-session workspace root (resolveTaskWorkspaceRoot). */
  workspaceRoot: string;
  mode: TaskMode;
}

/** One live task handed to the host: identity + the port + effective workspace. */
export interface TaskHandle {
  readonly taskId: string;
  readonly sessionId: string;
  readonly routeId: string;
  readonly mode: TaskMode;
  readonly workspaceKind: WorkspaceKind;
  /** Effective workspace the agent operates in (the worktree for isolated mode). */
  readonly workspaceRoot: string;
  /** Original user workspace the task was opened from. */
  readonly userWorkspaceRoot: string;
  readonly baselineCheckpointId: string;
  readonly port: TaskRuntimePort;
}

/** Task event notification forwarded to hosts (Task 7 bridges this to IPC). */
export interface TaskEventNotification {
  readonly taskId: string;
  readonly event: CoreTaskEvent;
}

export interface TaskRuntimeBridgeOptions {
  /** Private task storage base (userData/tasks in the host; temp in tests). */
  readonly taskStorageDir: string;
  /** Git adapter; defaults to the real task-git CLI adapter. */
  readonly git?: GitAdapter;
  /** Isolated worktree placement; defaults to <taskStorageDir>/worktrees. */
  readonly worktreeDir?: string;
  /** Lock pair override (tests record the fixed acquire order through it). */
  readonly locks?: { task: TaskMutationLock; workspace: WorkspaceWriteLock };
  /** Injected event emitter — the bridge itself never touches webContents. */
  readonly onTaskEvent?: (notification: TaskEventNotification) => void;
  readonly log?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
}

export interface TaskRuntimeBridge {
  start(request: TaskStartRequest): Promise<TaskHandle>;
  get(taskId: string): TaskHandle | undefined;
  getRoute(taskId: string, routeId: string): TaskHandle | undefined;
  listTasks(): string[];
  /** Event log of one task (the single log: core + plugin events). */
  listEvents(taskId: string): Promise<readonly CoreTaskEvent[]>;
  forkRoute(input: ForkRouteInput): Promise<Route & { prompt: string }>;
  /** Restores persisted route worktrees after process restart. */
  recoverTask(taskId: string): Promise<TaskState>;
  /** Subscribes to task events (complements the injected emitter). */
  onTaskEvent(listener: (notification: TaskEventNotification) => void): () => void;
  /** Releases one task's runtime resources: watcher + lease records. Worktrees survive. */
  releaseTask(taskId: string): Promise<void>;
  /** Explicit task deletion: destroys the worktree and releases everything. */
  deleteTask(taskId: string): Promise<void>;
  /** App quit path: releases every task (worktrees survive restarts). */
  disposeAll(): Promise<void>;
}

interface LiveRoute {
  readonly handle: TaskHandle;
  readonly port: LiveTaskPort;
  readonly watcher: WorkspaceWatcher;
  readonly lease?: WorktreeLease;
}

interface LiveTask {
  readonly handle: TaskHandle;
  readonly repository: TaskRepository;
  readonly baseline?: GitBaseline;
  readonly taskLock: TaskMutationLock;
  readonly workspaceLock: WorkspaceWriteLock;
  readonly routes: Map<string, LiveRoute>;
  readonly workspaceRoot: string;
}

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

let mintSeq = 0;
const mintId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${(mintSeq++).toString(36)}`;

/** .git internals never belong to workspace snapshots or watchers. */
const isGitInternal = (relativePath: string) =>
  relativePath === ".git" || relativePath.startsWith(".git/");

export function createTaskRuntimeBridge(options: TaskRuntimeBridgeOptions): TaskRuntimeBridge {
  const git = options.git ?? createGitAdapter();
  const worktreeDir = options.worktreeDir ?? path.join(options.taskStorageDir, "worktrees");
  const log = options.log ?? (() => {});
  const live = new Map<string, LiveTask>();
  const listeners = new Set<(notification: TaskEventNotification) => void>();

  const emit = (taskId: string, event: CoreTaskEvent): void => {
    const notification: TaskEventNotification = { taskId, event };
    options.onTaskEvent?.(notification);
    for (const listener of listeners) listener(notification);
  };

  async function startTask(request: TaskStartRequest): Promise<TaskHandle> {
    if (!request.workspaceRoot) {
      throw new Error("task bridge: start requires a workspaceRoot");
    }
    const taskId = request.taskId ?? mintId("task");
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new Error(`task bridge: unsafe task id: ${JSON.stringify(taskId)}`);
    }
    const existing = live.get(taskId);
    if (existing) return existing.handle;

    const routeId = request.routeId ?? "main";
    const userRoot = path.resolve(request.workspaceRoot);
    const repository = await openTaskRepository(options.taskStorageDir, taskId);
    if (await repository.readTaskHead()) {
      throw new Error(
        `task bridge: task ${JSON.stringify(taskId)} already exists on disk (restart recovery is a later phase)`,
      );
    }
    const locks =
      options.locks ?? {
        task: createTaskMutationLock(repository.storage.locksStorage),
        workspace: createWorkspaceWriteLock(repository.storage.locksStorage),
      };

    // Workspace class: ONLY a proven non-repository degrades to snapshot;
    // any other git failure propagates (never silently downgrade).
    let kind: WorkspaceKind = "snapshot";
    try {
      await git.detect(userRoot);
      kind = "git";
    } catch (error) {
      if (!(error instanceof GitWorkspaceError)) throw error;
    }

    // Baseline capture BEFORE any agent run — for Git this records the
    // user's uncommitted work (staged/dirty/untracked) without touching the
    // index; it is durable (artifact) because isolated worktree recovery
    // replays it.
    let gitLease: WorktreeLease | undefined;
    let effectiveRoot = userRoot;
    let baseline: GitBaseline | undefined;
    if (kind === "git") {
      baseline = await git.captureBaseline(userRoot);
      await repository.storage.storage.writeFileAtomic(
        "baseline.json",
        `${JSON.stringify(baseline, null, 2)}\n`,
      );
      if (request.mode === "isolated") {
        try {
          gitLease = await git.createWorktree({
            root: userRoot,
            path: path.join(worktreeDir, taskId),
          });
        } catch (error) {
          // Fail closed: isolated means isolated — NO baseline fallback.
          throw new Error(
            `task bridge: isolated worktree creation failed (no baseline fallback): ${String(error)}`,
          );
        }
      }
    } else if (request.mode === "isolated") {
      throw new Error(
        "task bridge: isolated mode requires a Git workspace; refusing snapshot fallback",
      );
    }

    // Baseline checkpoint: CAS-put the effective workspace's files, then the
    // manifest that references them (checkpoint content before the manifest,
    // the same durability order the turn commit coordinator uses).
    // The protected region starts the moment the attempt owns ANY resource
    // (the worktree lease): every failure from the overlay on destroys the
    // worktree, so a partial start can never orphan one.
    const checkpointId = mintId("ckpt");
    let watcher: WorkspaceWatcher | undefined;
    try {
      if (gitLease && baseline) {
        await git.overlayBaseline(gitLease, baseline);
        effectiveRoot = gitLease.path;
      }
      const snapshot = await scanWorkspace(effectiveRoot);
      const files = snapshot.files.filter((file) => !isGitInternal(file.path));
      for (const file of files) {
        if (file.hash === null) continue;
        const bytes = await fs.readFile(path.join(effectiveRoot, ...file.path.split("/")));
        await repository.objects.put(new Uint8Array(bytes));
      }
      const checkpoint: Checkpoint = {
        checkpointId,
        taskId,
        routeId,
        turnId: "",
        files: files.map((file) => ({ ...file })),
      };
      await repository.writeCheckpoint(checkpoint);

      const created = taskCreatedEvent({
        taskId,
        sessionId: request.sessionId ?? mintId("session"),
        workspaceRoot: effectiveRoot,
        workspaceKind: kind,
        mode: request.mode,
        routeId,
        baselineCheckpointId: checkpointId,
        baseCommit: baseline?.headCommit ?? undefined,
      });
      await repository.append([created]);
      await repository.writeTaskHead(toTaskHead(reduceTask([created])));

      // Watcher over the EFFECTIVE workspace (worktree for isolated tasks).
      const port = new LiveTaskPort({
        taskId,
        workspaceRoot: effectiveRoot,
        repository,
        locks,
        onAppend: (event) => emit(taskId, event),
        log,
      });
      watcher = createWorkspaceWatcher(effectiveRoot, {
        onEvent: port.sink,
        ignore: isGitInternal,
      });
      await watcher.start();

      const handle: TaskHandle = Object.freeze({
        taskId,
        sessionId: created.sessionId,
        routeId,
        mode: request.mode,
        workspaceKind: kind,
        workspaceRoot: effectiveRoot,
        userWorkspaceRoot: userRoot,
        baselineCheckpointId: checkpointId,
        port,
      });
      live.set(taskId, {
        handle,
        repository,
        baseline,
        taskLock: locks.task,
        workspaceLock: locks.workspace,
        workspaceRoot: userRoot,
        routes: new Map([[routeId, { handle, port, watcher, lease: gitLease }]]),
      });
      emit(taskId, created);
      return handle;
    } catch (error) {
      // Partial start: release what this attempt created. The task never
      // existed, so an orphan worktree from THIS attempt is destroyed.
      await watcher?.stop().catch(() => undefined);
      if (gitLease) await git.destroyWorktree(gitLease).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Destroys a possibly-released task's worktree from durable state: the
   * persisted baseline records the repo root and HEAD, and the worktree path
   * is deterministic per task. Tasks without a baseline artifact (snapshot
   * mode, never started) have nothing to destroy.
   */
  async function destroyWorktreeOfTask(taskId: string): Promise<void> {
    try {
      const repository = await openTaskRepository(options.taskStorageDir, taskId);
      const events = await repository.list();
      const state = reduceTask(events);
      const raw = await repository.storage.storage.readTextFile("baseline.json").catch(() => null);
      if (raw === null) return;
      const baseline = JSON.parse(raw) as { root?: unknown; headCommit?: unknown };
      if (typeof baseline.root !== "string" || typeof baseline.headCommit !== "string") return;
      for (const route of state.routes.values()) {
        if (!route.baseCommit || route.parentRouteId === null) continue;
        await git.destroyWorktree({
          leaseId: `recovered:${taskId}:${route.routeId}`,
          repoRoot: baseline.root,
          path: route.workspaceRoot,
          baseCommit: route.baseCommit,
        });
      }
      if (state.mode === "isolated") {
        await git.destroyWorktree({
          leaseId: `recovered:${taskId}:main`,
          repoRoot: baseline.root,
          path: [...state.routes.values()].find((route) => route.parentRouteId === null)?.workspaceRoot ?? path.join(worktreeDir, taskId),
          baseCommit: baseline.headCommit,
        });
      }
    } catch (error) {
      log("error", "task worktree destroy failed", String(error));
    }
  }

  async function release(taskId: string, destroyWorktree: boolean): Promise<void> {
    const task = live.get(taskId);
    if (!task) {
      // Already released (or never started): explicit deletion still owns
      // the worktree; lease-only release has nothing left to do.
      if (destroyWorktree) await destroyWorktreeOfTask(taskId);
      return;
    }
    live.delete(taskId);
    for (const route of task.routes.values()) {
      route.port.markReleased();
      await route.watcher.stop().catch((error) => log("warn", "task watcher stop failed", String(error)));
    }
    const leases = [...task.routes.values()].flatMap((route) => route.lease ? [route.lease] : []);
    for (const lease of leases) {
      if (destroyWorktree) {
        await git
          .destroyWorktree(lease)
          .catch((error) => log("error", "task worktree destroy failed", String(error)));
      } else {
        // closeLease releases NOTHING on disk — every route worktree survives
        // quit/session teardown; destroyWorktree runs only on explicit deletion.
        await git.closeLease(lease).catch((error) =>
          log("warn", "task worktree lease close failed", String(error)),
        );
      }
    }
  }

  return {
    start: startTask,
    get: (taskId) => live.get(taskId)?.handle,
    getRoute: (taskId, routeId) => live.get(taskId)?.routes.get(routeId)?.handle,
    listTasks: () => [...live.keys()],
    async listEvents(taskId) {
      const task = live.get(taskId);
      if (task) return task.repository.list();
      // Not live: read from disk (fresh process / after release).
      const repository = await openTaskRepository(options.taskStorageDir, taskId);
      return repository.list();
    },
    async forkRoute(input) {
      const task = live.get(input.taskId);
      if (!task) throw new Error(`task bridge: task not live: ${input.taskId}`);
      if (!task.baseline) throw new Error("Git repository required for code-state fork");
      const result = await createForkedTaskRoute({
        repository: task.repository,
        git,
        taskLock: task.taskLock,
        baseline: task.baseline,
        userWorkspaceRoot: task.handle.userWorkspaceRoot,
        worktreeDir,
        mintRouteId: () => mintId("route"),
        prepareRoute: async (route, lease) => {
          const port = new LiveTaskPort({
            taskId: input.taskId,
            workspaceRoot: route.workspaceRoot,
            repository: task.repository,
            locks: { task: task.taskLock, workspace: task.workspaceLock },
            onAppend: (event) => emit(input.taskId, event),
            log,
          });
          const watcher = createWorkspaceWatcher(route.workspaceRoot, {
            onEvent: port.sink,
            ignore: isGitInternal,
          });
          await watcher.start();
          const handle: TaskHandle = Object.freeze({
            ...task.handle,
            routeId: route.routeId,
            workspaceRoot: route.workspaceRoot,
            port,
          });
          task.routes.set(route.routeId, { handle, port, watcher, lease });
          return async () => {
            task.routes.delete(route.routeId);
            port.markReleased();
            await watcher.stop();
          };
        },
      }, input);
      emit(input.taskId, result.event);
      return { ...result.route, prompt: result.prompt };
    },
    async recoverTask(taskId) {
      const existing = live.get(taskId);
      if (existing) return reduceTask(await existing.repository.list());
      const repository = await openTaskRepository(options.taskStorageDir, taskId);
      // Interrupted multi-file applies (journaled write loop in task-git) are
      // recovered FIRST: a partially applied user workspace must be rolled
      // back to pre-apply bytes before any worktree/checkpoint replay looks
      // at disk state. Committed journals are cleaned; proven-complete ones
      // are backfilled (see task-workspace apply-journal.ts).
      const journalReport = await repository.recoverApplyJournals();
      if (journalReport.rolledBack.length > 0) {
        log("warn", "task interrupted apply rolled back", {
          taskId,
          transactionIds: journalReport.completed,
          paths: journalReport.rolledBack,
        });
      }
      const state = reduceTask(await repository.list());
      // baseline.json hard-fails here by design: fork recovery is Git-only —
      // snapshot tasks have no worktree/baseline to recover (see fork.ts).
      const raw = await repository.storage.storage.readTextFile("baseline.json");
      const baseline = JSON.parse(raw) as GitBaseline;
      const locks = options.locks ?? {
        task: createTaskMutationLock(repository.storage.locksStorage),
        workspace: createWorkspaceWriteLock(repository.storage.locksStorage),
      };
      const routes = new Map<string, LiveRoute>();
      try {
        for (const route of state.routes.values()) {
          const checkpoint = await repository.readCheckpoint(route.checkpointId);
          if (!checkpoint) throw new Error(`checkpoint not found: ${route.checkpointId}`);
          let lease: WorktreeLease | undefined;
          if (route.baseCommit && (route.parentRouteId !== null || state.mode === "isolated")) {
            lease = await git.recoverWorktree({
              root: baseline.root,
              path: route.workspaceRoot,
              baseCommit: route.baseCommit,
              baseline,
              checkpointFiles: checkpoint.files.map((file) => ({ path: file.path, hash: file.hash })),
              readContent: (hash) => repository.objects.get(hash),
            });
          }
          const port = new LiveTaskPort({
            taskId,
            workspaceRoot: route.workspaceRoot,
            repository,
            locks,
            onAppend: (event) => emit(taskId, event),
            log,
          });
          const watcher = createWorkspaceWatcher(route.workspaceRoot, { onEvent: port.sink, ignore: isGitInternal });
          await watcher.start();
          const handle: TaskHandle = Object.freeze({
            taskId,
            sessionId: state.sessionId,
            routeId: route.routeId,
            mode: state.mode,
            workspaceKind: state.workspaceKind,
            workspaceRoot: route.workspaceRoot,
            userWorkspaceRoot: baseline.root,
            baselineCheckpointId: state.routes.get("main")?.checkpointId ?? route.checkpointId,
            port,
          });
          routes.set(route.routeId, { handle, port, watcher, lease });
        }
        const handle = routes.get(state.activeRouteId)?.handle ?? routes.values().next().value?.handle;
        if (!handle) throw new Error(`task ${taskId} has no recoverable routes`);
        live.set(taskId, {
          handle,
          repository,
          baseline,
          taskLock: locks.task,
          workspaceLock: locks.workspace,
          workspaceRoot: baseline.root,
          routes,
        });
        return state;
      } catch (error) {
        for (const route of routes.values()) {
          route.port.markReleased();
          await route.watcher.stop().catch(() => undefined);
          if (route.lease) await git.closeLease(route.lease).catch(() => undefined);
        }
        throw error;
      }
    },
    onTaskEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    releaseTask: (taskId) => release(taskId, false),
    deleteTask: (taskId) => release(taskId, true),
    async disposeAll() {
      await Promise.all([...live.keys()].map((taskId) => release(taskId, false)));
    },
  };
}

/**
 * plugin-task middleware for one route-scoped agent session: attached by the
 * host composition root (harnessGlue) when the runtime builds a session for
 * a live task. Empty for plain chat (no task) or unknown tasks.
 */
export function taskPluginsForRoute(
  bridge: TaskRuntimeBridge,
  context: { taskId?: string; routeId: string; toolIndex: SessionToolIndex },
): HarnessPlugin[] {
  if (!context.taskId) return [];
  const handle = context.routeId
    ? bridge.getRoute(context.taskId, context.routeId)
    : bridge.get(context.taskId);
  if (!handle) return [];
  return [
    taskPlugin({
      port: handle.port as TaskRuntimePort,
      lookupTool: (toolName) => context.toolIndex.get(toolName),
      workspaceRoot: handle.workspaceRoot,
    }),
  ];
}

/**
 * Authoritative workspace root resolution: settings.workspaceRoot is NOT the
 * sole task root — a session created inside a project keeps ITS root; only
 * sessions without one fall back to the settings value. Injectable so hosts
 * (and Task 7 IPC handlers) can pass their session store without this
 * module depending on it.
 */
export function resolveTaskWorkspaceRoot(
  sessionId: string,
  resolution: {
    getSessionWorkspaceRoot(sessionId: string): string | undefined;
    fallbackRoot: string;
  },
): string {
  return resolution.getSessionWorkspaceRoot(sessionId) || resolution.fallbackRoot;
}
