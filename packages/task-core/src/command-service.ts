/**
 * The ONE host-agnostic TaskCommandService (Task 13). Every command of the
 * fixed method set orchestrates the ports declared in command-ports.ts; every
 * mutation acquires its TaskMutationLease INSIDE this service (task lease →
 * workspace lease, the fixed order) and enforces ownership, expectedVersion
 * CAS and the completion/attribution gates here. Adapters (Electron IPC
 * handlers, the CLI adapter in @innocencecode/task-cli) only delegate — they
 * never touch task storage directly.
 *
 * Semantics parity with the Electron surface (paths, expectedVersion,
 * completion gate, review) is asserted by packages/task-core/tests/
 * command-service-contract.test.ts and the Electron↔CLI parity checks.
 */
import {
  forkFromUserMessage,
  retryAssistantTurn,
} from "./fork";
import {
  activeRouteChangedEvent,
  conflictResolvedEvent,
  hunkReviewedEvent,
  taskCreatedEvent,
  taskStatusEvent,
  turnCheckpointedEvent,
  validationOverrideEvent,
  type TaskEvent,
} from "./events";
import { createNodeIdClock, type TaskIdClock } from "./ports";
import {
  reduceTask,
  toTaskHead,
  type TaskState,
} from "./reducer";
import {
  type Checkpoint,
  type Hunk,
  type Route,
  type TaskMode,
  type TaskStatus,
  type WorkspaceKind,
} from "./model";
import type {
  TaskApplyConflict,
  TaskAttributionPort,
  TaskCommandGit,
  TaskCommandLocks,
  TaskCommandStore,
  TaskCommandWorkspace,
  TaskDeletePort,
  TaskDiffPort,
  TaskFilePatch,
  TaskForkCommand,
  TaskMutationLease,
  TaskRecoverPort,
  TaskRouteForkPort,
  TaskStartedInfo,
  TaskValidationResult,
  TaskValidator,
} from "./command-ports";
import { TaskCommandError } from "./command-ports";

export { TaskCommandError } from "./command-ports";

/** The plan-fixed method set every TaskCommandService exposes. */
export const TASK_COMMAND_METHODS = [
  "start",
  "get",
  "getChanges",
  "getCheckpoint",
  "listRoutes",
  "switchRoute",
  "forkFromUser",
  "retryAssistant",
  "listHunks",
  "review",
  "restore",
  "attributeUnknown",
  "resolveConflict",
  "validate",
  "complete",
  "applyAccepted",
  "recover",
  "delete",
  "recoveryWarnings",
] as const;

export interface TaskStartCommand {
  workspaceRoot: string;
  mode: TaskMode;
  sessionId?: string;
  taskId?: string;
  routeId?: string;
}

export interface TaskGetResult {
  taskId: string;
  sessionId: string;
  status: TaskStatus;
  activeRouteId: string;
  mode: TaskMode;
  workspaceKind: WorkspaceKind;
  version?: string;
  unreviewedChanges: number;
}

export interface TaskRouteSummaryDto {
  routeId: string;
  parentRouteId: string | null;
  forkTurnId: string | null;
  checkpointId: string;
  workspaceKind: WorkspaceKind;
}

export interface TaskForkResult {
  route: TaskRouteSummaryDto & { workspaceRoot?: string };
  prompt: string;
}

export interface CompletionGateDto {
  runningTools: number;
  unresolvedConflicts: number;
  unstableCalls: number;
  unreviewedChanges: number;
  validation: TaskValidationResult | null;
}

export interface TaskCommandService {
  start(request: TaskStartCommand): Promise<TaskStartedInfo>;
  get(taskId: string): Promise<TaskGetResult>;
  getChanges(taskId: string, routeId: string): Promise<TaskFilePatch[]>;
  getCheckpoint(taskId: string, checkpointId: string): Promise<Checkpoint | null>;
  listRoutes(taskId: string): Promise<TaskRouteSummaryDto[]>;
  switchRoute(taskId: string, routeId: string): Promise<TaskRouteSummaryDto>;
  forkFromUser(request: TaskForkCommand & { editedText: string }): Promise<TaskForkResult>;
  retryAssistant(request: TaskForkCommand): Promise<TaskForkResult>;
  listHunks(taskId: string, routeId: string): Promise<Hunk[]>;
  review(request: {
    taskId: string;
    routeId: string;
    hunkRef: string;
    status: "accepted" | "restored";
    expectedVersion?: string;
  }): Promise<void>;
  restore(request: {
    taskId: string;
    routeId: string;
    hunkRef: string;
    expectedVersion: string;
  }): Promise<void>;
  attributeUnknown(taskId: string, path: string, attribution: "task-owned" | "external"): Promise<void>;
  resolveConflict(request: {
    taskId: string;
    routeId: string;
    path: string;
    attribution: "task-owned" | "external";
  }): Promise<void>;
  validate(taskId: string, routeId: string): Promise<TaskValidationResult>;
  complete(request: { taskId: string; confirmValidationFailure: boolean }): Promise<void>;
  applyAccepted(
    taskId: string,
    routeId: string,
    options?: { dryRun?: boolean },
  ): Promise<{ applied: string[]; conflicts: TaskApplyConflict[] }>;
  recover(taskId: string): Promise<TaskGetResult>;
  delete(taskId: string): Promise<void>;
  recoveryWarnings(taskId: string): Promise<string[]>;

  // -- Host escape hatches beyond the fixed set (documented): the Electron
  //    DTO surface's checkpoint/status channels and raw appends. ------------
  createCheckpoint(taskId: string, routeId: string): Promise<{ checkpointId: string }>;
  changeStatus(taskId: string, status: string): Promise<void>;
  append(taskId: string, event: TaskEvent): Promise<void>;
}

export interface TaskCommandDeps {
  store: TaskCommandStore;
  locks: TaskCommandLocks;
  workspace: TaskCommandWorkspace;
  git: TaskCommandGit;
  diff: TaskDiffPort;
  attribution: TaskAttributionPort;
  fork: TaskRouteForkPort;
  recover: TaskRecoverPort;
  delete: TaskDeletePort;
  validator?: TaskValidator;
  /** Isolated worktree placement; required for isolated starts. */
  worktreeDir?: string;
  /** Bounded wait for the lease pair (default 30s; never waits forever). */
  lockTimeoutMs?: number;
  clock?: TaskIdClock;
  onEvent?: (taskId: string, event: TaskEvent) => void;
  /** Agent-writer seam: invoked after a task becomes durable (tests simulate agent writes here). */
  onTaskStarted?: (task: TaskStartedInfo) => Promise<void>;
  log?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
}

const TASK_STATUSES: ReadonlySet<string> = new Set<TaskStatus>([
  "ready", "running", "review", "paused", "completed", "interrupted", "checkpoint-failed",
]);
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/** .git internals never belong to snapshots (mirrors task-workspace's predicate). */
const isGitInternal = (relativePath: string) => relativePath === ".git" || relativePath.startsWith(".git/");

/**
 * Opaque workspace version token: the last committed event id — the SAME
 * token main's TaskGetResponse.version hands the renderer, so CAS-flavored
 * commands round-trip between hosts unchanged.
 */
function versionOf(events: readonly TaskEvent[]): string {
  return events.at(-1)?.eventId ?? "";
}

function routeSummary(state: TaskState, route: Route): TaskRouteSummaryDto {
  return {
    routeId: route.routeId,
    parentRouteId: route.parentRouteId,
    forkTurnId: route.forkTurnId,
    checkpointId: route.checkpointId,
    workspaceKind: state.workspaceKind,
  };
}

export function createTaskCommandService(deps: TaskCommandDeps): TaskCommandService {
  const clock = deps.clock ?? createNodeIdClock();
  const log = deps.log ?? (() => {});
  const lockTimeoutMs = deps.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  async function eventsOf(taskId: string): Promise<TaskEvent[]> {
    const events = await deps.store.listEvents(taskId);
    if (events.length === 0) {
      throw new TaskCommandError("task-not-found", `task not found: ${taskId}`);
    }
    return events;
  }

  async function stateOf(taskId: string): Promise<TaskState> {
    return reduceTask(await eventsOf(taskId));
  }

  function routeOf(state: TaskState, routeId: string): Route {
    const route = state.routes.get(routeId);
    if (route === undefined) {
      throw new TaskCommandError("route-not-found", `route not found: ${routeId} in task ${state.taskId}`);
    }
    return route;
  }

  function assertVersion(expected: string | undefined, events: readonly TaskEvent[]): void {
    if (expected !== undefined && expected !== versionOf(events)) {
      throw new TaskCommandError(
        "version-conflict",
        `task version conflict: expected ${expected}, current ${versionOf(events)}`,
      );
    }
  }

  /**
   * Runs `fn` under one mutation lease: task lease first, workspace lease
   * second, fresh event log re-read under the lease (the CAS basis), reverse
   * release order. Lease waits are bounded by deps.lockTimeoutMs.
   */
  async function withMutation<T>(
    taskId: string,
    routeId: string,
    fn: (context: TaskMutationLease, events: TaskEvent[], state: TaskState) => Promise<T>,
  ): Promise<T> {
    const preState = await stateOf(taskId);
    const route = routeOf(preState, routeId);
    const workspaceKey = await deps.workspace.canonicalKey(route.workspaceRoot);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), lockTimeoutMs);
    const acquire = async (label: string, run: () => Promise<AsyncDisposable>) => {
      try {
        return await run();
      } catch (error) {
        if (String(error).toLowerCase().includes("abort")) {
          throw new TaskCommandError("lock-timeout", `timed out acquiring the ${label} lease for task ${taskId}`);
        }
        throw error;
      }
    };
    const taskLease = await acquire("task", () =>
      deps.locks.acquireTaskLease(taskId, { taskId, routeId }, controller.signal));
    let workspaceLease: AsyncDisposable | undefined;
    const leaseToken = Symbol(`task-command:${taskId}:${routeId}`);
    try {
      workspaceLease = await acquire("workspace", () =>
        deps.locks.acquireWorkspaceLease(workspaceKey, { taskId, routeId }, controller.signal));
      const context: TaskMutationLease = {
        taskId, routeId, workspaceKey, leaseToken,
        [Symbol.asyncDispose]: async () => {},
      };
      const events = await eventsOf(taskId);
      return await fn(context, events, reduceTask(events));
    } finally {
      if (workspaceLease !== undefined) {
        await Promise.resolve(workspaceLease[Symbol.asyncDispose]()).catch(() => undefined);
      }
      await Promise.resolve(taskLease[Symbol.asyncDispose]()).catch(() => undefined);
      clearTimeout(timer);
    }
  }

  async function appendDurable(taskId: string, events: readonly TaskEvent[]): Promise<void> {
    await deps.store.appendEvents(taskId, events);
    for (const event of events) deps.onEvent?.(taskId, event);
  }

  /** Checkpoint-vs-workspace patches for one route. */
  async function patchesOf(taskId: string, _state: TaskState, route: Route): Promise<TaskFilePatch[]> {
    const checkpoint = await deps.store.readCheckpoint(taskId, route.checkpointId);
    if (checkpoint === null) {
      throw new TaskCommandError("invalid-request", `checkpoint not found: ${route.checkpointId}`);
    }
    const scan = await deps.workspace.scan(route.workspaceRoot);
    return deps.diff.diff({
      before: {
        files: checkpoint.files,
        readContent: (hash) => deps.store.getObject(taskId, hash),
      },
      after: { root: scan.root, files: scan.files.filter((file) => !isGitInternal(file.path)) },
    });
  }

  /** Hunks with persisted review statuses and attribution-conflict marks applied. */
  async function statusedHunks(taskId: string, state: TaskState, route: Route, events: readonly TaskEvent[]): Promise<Hunk[]> {
    const patches = await patchesOf(taskId, state, route);
    const decisions = deps.attribution.decisions(events);
    const conflictedPaths = new Set(
      decisions.filter((decision) => decision.status === "conflict" || decision.status === "attribution-pending" || decision.status === "candidate")
        .map((decision) => decision.path),
    );
    const reviewed = new Map<string, "accepted" | "restored">();
    for (const event of events) {
      if (event.type === "hunkReviewed" && event.routeId === route.routeId) {
        reviewed.set(event.hunkRef, event.status);
      }
    }
    return patches.flatMap((patch) =>
      patch.hunks.map((hunk) => ({
        ...hunk,
        status: conflictedPaths.has(hunk.path)
          ? ("conflict" as const)
          : reviewed.get(hunk.ref) ?? hunk.status,
      })),
    );
  }

  function getOf(state: TaskState): Omit<TaskGetResult, "unreviewedChanges"> {
    return {
      taskId: state.taskId,
      sessionId: state.sessionId,
      status: state.status,
      activeRouteId: state.activeRouteId,
      mode: state.mode,
      workspaceKind: state.workspaceKind,
      version: state.lastCommittedEventId ?? undefined,
    };
  }

  async function withUnreviewed(taskId: string, state: TaskState): Promise<TaskGetResult> {
    const route = routeOf(state, state.activeRouteId);
    const events = await eventsOf(taskId);
    const hunks = await statusedHunks(taskId, state, route, events);
    return {
      ...getOf(state),
      unreviewedChanges: hunks.filter((hunk) => hunk.status !== "accepted" && hunk.status !== "restored").length,
    };
  }

  async function forkWith(
    request: TaskForkCommand,
    resolve: (state: TaskState) => { parentRouteId: string; sourceTurnId: string; checkpointId: string; prompt: string },
    mode: "edit-user" | "retry-assistant",
  ): Promise<TaskForkResult> {
    const state = await stateOf(request.taskId);
    if (state.sessionId !== request.sessionId) {
      throw new TaskCommandError("session-scope", "forkRoute session scope");
    }
    const resolved = resolve(state);
    const result = await deps.fork.createForkedRoute({ taskId: request.taskId, mode, request, resolved, state });
    const nextState = await stateOf(request.taskId);
    return {
      route: { ...routeSummary(nextState, result.route), workspaceRoot: result.route.workspaceRoot },
      prompt: result.prompt,
    };
  }

  return {
    async start(request) {
      if (!request.workspaceRoot) {
        throw new TaskCommandError("invalid-request", "start requires a workspaceRoot");
      }
      const taskId = request.taskId ?? clock.newId("task");
      if (!TASK_ID_PATTERN.test(taskId)) {
        throw new TaskCommandError("invalid-request", `unsafe task id: ${JSON.stringify(taskId)}`);
      }
      const routeId = request.routeId ?? "main";
      const info = await deps.git.detect(request.workspaceRoot);
      const kind: WorkspaceKind = info.isRepo ? "git" : "snapshot";
      if (kind === "snapshot" && request.mode === "isolated") {
        throw new TaskCommandError(
          "invalid-request",
          "isolated mode requires a Git workspace; refusing snapshot fallback",
        );
      }
      const baseline = kind === "git" ? await deps.git.captureBaseline(info.root) : undefined;
      if (baseline !== undefined) {
        await deps.store.writeArtifact(taskId, "baseline.json", `${JSON.stringify(baseline, null, 2)}\n`);
      }
      let effectiveRoot = request.workspaceRoot;
      let worktreeLease: unknown;
      const checkpointId = clock.newId("ckpt");
      try {
        if (request.mode === "isolated" && baseline !== undefined) {
          if (!deps.worktreeDir) {
            throw new TaskCommandError("invalid-request", "isolated mode requires a worktreeDir");
          }
          const created = await deps.git.createWorktree({
            root: info.root,
            path: `${deps.worktreeDir}/${taskId}`.replaceAll("\\", "/"),
          });
          await deps.git.overlayBaseline(created.lease, baseline);
          effectiveRoot = created.path;
          worktreeLease = created.lease;
        }
        const scan = await deps.workspace.scan(effectiveRoot);
        const files = scan.files.filter((file) => !isGitInternal(file.path));
        for (const file of files) {
          if (file.hash === null) continue;
          const bytes = await deps.workspace.read(effectiveRoot, file.path);
          if (bytes !== null) await deps.store.putObject(taskId, bytes);
        }
        await deps.store.writeCheckpoint(taskId, {
          checkpointId, taskId, routeId, turnId: "", files: files.map((file) => ({ ...file })),
        });
        const created = taskCreatedEvent({
          taskId,
          sessionId: request.sessionId ?? clock.newId("session"),
          workspaceRoot: effectiveRoot,
          workspaceKind: kind,
          mode: request.mode,
          routeId,
          baselineCheckpointId: checkpointId,
          ...(baseline !== undefined && typeof baseline === "object" && baseline !== null && "headCommit" in baseline
            ? { baseCommit: String((baseline as { headCommit: unknown }).headCommit ?? "") || undefined }
            : {}),
          clock,
        });
        await appendDurable(taskId, [created]);
        await deps.store.writeTaskHead(taskId, toTaskHead(reduceTask([created])));
        const started: TaskStartedInfo = {
          taskId,
          sessionId: created.sessionId,
          routeId,
          activeRouteId: routeId,
          workspaceRoot: effectiveRoot,
          workspaceKind: kind,
          mode: request.mode,
          baselineCheckpointId: checkpointId,
          version: created.eventId ?? "",
        };
        await deps.onTaskStarted?.(started);
        return started;
      } catch (error) {
        if (worktreeLease !== undefined) {
          await deps.git.destroyWorktree(worktreeLease).catch(() => undefined);
        }
        throw error;
      }
    },

    async get(taskId) {
      return withUnreviewed(taskId, await stateOf(taskId));
    },

    async getChanges(taskId, routeId) {
      const state = await stateOf(taskId);
      return patchesOf(taskId, state, routeOf(state, routeId));
    },

    async getCheckpoint(taskId, checkpointId) {
      await eventsOf(taskId);
      return deps.store.readCheckpoint(taskId, checkpointId);
    },

    async listRoutes(taskId) {
      const state = await stateOf(taskId);
      return [...state.routes.values()].map((route) => routeSummary(state, route));
    },

    async switchRoute(taskId, routeId) {
      const summary = await withMutation(taskId, routeId, async (_context, events) => {
        const state = reduceTask(events);
        const route = routeOf(state, routeId);
        await appendDurable(taskId, [activeRouteChangedEvent({ routeId, clock })]);
        return routeSummary(state, route);
      });
      return summary;
    },

    async forkFromUser(request) {
      return forkWith(
        request,
        (state) => forkFromUserMessage(state, {
          routeId: request.sourceRouteId,
          turnId: request.sourceTurnId,
          editedText: request.editedText ?? "",
        }),
        "edit-user",
      );
    },

    async retryAssistant(request) {
      return forkWith(
        request,
        (state) => retryAssistantTurn(state, {
          routeId: request.sourceRouteId,
          turnId: request.sourceTurnId,
        }),
        "retry-assistant",
      );
    },

    async listHunks(taskId, routeId) {
      const state = await stateOf(taskId);
      const route = routeOf(state, routeId);
      return statusedHunks(taskId, state, route, await eventsOf(taskId));
    },

    async review(request) {
      await withMutation(request.taskId, request.routeId, async (_context, events, state) => {
        assertVersion(request.expectedVersion, events);
        const route = routeOf(state, request.routeId);
        const hunks = await statusedHunks(request.taskId, state, route, events);
        if (!hunks.some((hunk) => hunk.ref === request.hunkRef)) {
          throw new TaskCommandError("hunk-not-found", `hunk not found: ${request.hunkRef}`);
        }
        await appendDurable(request.taskId, [
          hunkReviewedEvent({ routeId: request.routeId, hunkRef: request.hunkRef, status: request.status, clock }),
        ]);
      });
    },

    async restore(request) {
      await withMutation(request.taskId, request.routeId, async (_context, events, state) => {
        assertVersion(request.expectedVersion, events);
        const route = routeOf(state, request.routeId);
        const patches = await patchesOf(request.taskId, state, route);
        const patch = patches.find((candidate) => candidate.hunks.some((hunk) => hunk.ref === request.hunkRef));
        if (patch === undefined) {
          throw new TaskCommandError("hunk-not-found", `hunk not found: ${request.hunkRef}`);
        }
        const result = await deps.git.applyAccepted({
          mode: "baseline",
          root: route.workspaceRoot,
          files: [{
            path: patch.path,
            expectedHash: patch.after.hash,
            restoreHash: patch.before.hash,
          }],
          readContent: (hash) => deps.store.getObject(request.taskId, hash),
        });
        if (result.conflicts.length > 0) {
          throw new TaskCommandError("apply-conflict", `restore conflict at ${result.conflicts[0]!.path}`, result.conflicts);
        }
        await appendDurable(request.taskId, [
          hunkReviewedEvent({ routeId: request.routeId, hunkRef: request.hunkRef, status: "restored", clock }),
        ]);
      });
    },

    async attributeUnknown(taskId, path, attribution) {
      await withMutation(taskId, (await stateOf(taskId)).activeRouteId, async (_context, events) => {
        const decision = deps.attribution.decisions(events).find((candidate) => candidate.path === path);
        if (decision === undefined) {
          throw new TaskCommandError("invalid-request", `task attribution: no decision tracked for ${path}`);
        }
        if (decision.status !== "attribution-pending") {
          throw new TaskCommandError(
            "invalid-request",
            `task attribution: ${path} is "${decision.status}", not attribution-pending`,
          );
        }
        await appendDurable(taskId, [{
          type: "attributionResolved",
          path,
          attribution,
          status: attribution === "task-owned" ? "pending-review" : "excluded",
          protectedHash: attribution === "task-owned" ? null : "",
          eventId: clock.newId("event"),
          at: clock.now(),
        }]);
      });
    },

    async resolveConflict(request) {
      await withMutation(request.taskId, request.routeId, async (_context, events) => {
        const decision = deps.attribution.decisions(events).find((candidate) => candidate.path === request.path);
        if (decision === undefined) {
          throw new TaskCommandError("invalid-request", `task attribution: no decision tracked for ${request.path}`);
        }
        if (decision.status !== "conflict") {
          throw new TaskCommandError(
            "invalid-request",
            `task attribution: ${request.path} is "${decision.status}", not conflict`,
          );
        }
        await appendDurable(request.taskId, [
          conflictResolvedEvent({ path: request.path, attribution: request.attribution, clock }),
        ]);
      });
    },

    async validate(taskId, routeId) {
      const state = await stateOf(taskId);
      const route = routeOf(state, routeId);
      return deps.validator
        ? deps.validator(taskId, routeId, route.workspaceRoot)
        : { success: true };
    },

    async complete(request) {
      const state = await stateOf(request.taskId);
      const route = routeOf(state, state.activeRouteId);
      const events = await eventsOf(request.taskId);
      const hunks = await statusedHunks(request.taskId, state, route, events);
      const validation = deps.validator
        ? await deps.validator(request.taskId, state.activeRouteId, route.workspaceRoot)
        : { success: true };
      const gate: CompletionGateDto = {
        runningTools: 0, // P1: single-turn, no live tool index in the service
        unresolvedConflicts: deps.attribution.decisions(events)
          .filter((decision) => decision.status === "conflict").length,
        unstableCalls: [...state.turns.values()].filter((turn) => turn.phase === "prepared").length,
        unreviewedChanges: hunks.filter((hunk) => hunk.status !== "accepted" && hunk.status !== "restored").length,
        validation,
      };
      if (request.confirmValidationFailure && validation !== null && !validation.success) {
        gate.validation = null;
        await withMutation(request.taskId, state.activeRouteId, async () => {
          await appendDurable(request.taskId, [validationOverrideEvent({ validationResult: validation, clock })]);
        });
      }
      const blocks = gate.unresolvedConflicts > 0 || gate.unstableCalls > 0 ||
        gate.unreviewedChanges > 0 || (gate.validation !== null && !gate.validation.success);
      if (blocks) {
        throw new TaskCommandError("completion-gate", "completion gate", { gate });
      }
    },

    async applyAccepted(taskId, routeId, options) {
      const state = await stateOf(taskId);
      const route = routeOf(state, routeId);
      const events = await eventsOf(taskId);
      const patches = await patchesOf(taskId, state, route);
      const hunks = await statusedHunks(taskId, state, route, events);
      const unreviewed = hunks.filter((hunk) => hunk.status !== "accepted" && hunk.status !== "restored");
      if (unreviewed.length > 0) {
        throw new TaskCommandError("completion-gate", "completion gate", {
          gate: { unreviewedChanges: unreviewed.length },
        });
      }
      // Patch hunks are always derived "pending"; the PERSISTED decisions live
      // on the statused hunks — a file applies only when every hunk of it was
      // accepted (restored files were reverted and never land).
      const statusByRef = new Map(hunks.map((hunk) => [hunk.ref, hunk.status]));
      const accepted = patches.filter((patch) =>
        patch.hunks.length > 0 && patch.hunks.every((hunk) => statusByRef.get(hunk.ref) === "accepted"));
      if (state.mode === "baseline" || state.workspaceKind !== "git") {
        // Baseline tasks already live in the user workspace: apply is the
        // confirmation step; restore() has reverted every rejected change.
        return { applied: accepted.map((patch) => patch.path), conflicts: [] };
      }
      const rawBaseline = await deps.store.readArtifact(taskId, "baseline.json");
      if (rawBaseline === null) {
        throw new TaskCommandError("invalid-request", "baseline.json not found for isolated apply");
      }
      const baseline = JSON.parse(rawBaseline) as { root?: unknown };
      if (typeof baseline.root !== "string") {
        throw new TaskCommandError("invalid-request", "baseline.json has no root");
      }
      const scan = await deps.workspace.scan(route.workspaceRoot);
      const contentPath = new Map(scan.files.map((file) => [file.hash ?? "", file.path]));
      const input = {
        mode: "isolated" as const,
        root: baseline.root,
        files: accepted.map((patch) => ({
          path: patch.path,
          baseHash: patch.before.hash,
          incomingHash: patch.after.hash,
        })),
        readContent: async (hash: string) => {
          const relativePath = contentPath.get(hash);
          if (relativePath === undefined) throw new Error(`apply content not found: ${hash}`);
          const bytes = await deps.workspace.read(route.workspaceRoot, relativePath);
          if (bytes === null) throw new Error(`apply content unreadable: ${relativePath}`);
          return bytes;
        },
      };
      if (options?.dryRun) {
        const report = await deps.git.preflightApply(input);
        return { applied: [], conflicts: report.conflicts };
      }
      const result = await deps.git.applyAccepted(input);
      return { applied: result.applied, conflicts: result.conflicts };
    },

    async recover(taskId) {
      const state = await deps.recover.recoverTask(taskId);
      return withUnreviewed(taskId, state);
    },

    async delete(taskId) {
      await eventsOf(taskId);
      await deps.delete.deleteTask(taskId);
      log("info", "task deleted", { taskId });
    },

    async recoveryWarnings(taskId) {
      const state = await stateOf(taskId);
      return [...state.turns.values()]
        .filter((turn) => turn.phase === "prepared")
        .map((turn) => `turn ${turn.turnId} is prepared but not committed`);
    },

    // -- Host escape hatches beyond the fixed set ---------------------------

    async createCheckpoint(taskId, routeId) {
      const checkpointId = await withMutation(taskId, routeId, async () => {
        const state = reduceTask(await eventsOf(taskId));
        const route = routeOf(state, routeId);
        const id = clock.newId("ckpt");
        const scan = await deps.workspace.scan(route.workspaceRoot);
        const files = scan.files.filter((file) => !isGitInternal(file.path));
        for (const file of files) {
          if (file.hash === null) continue;
          const bytes = await deps.workspace.read(route.workspaceRoot, file.path);
          if (bytes !== null) await deps.store.putObject(taskId, bytes);
        }
        await deps.store.writeCheckpoint(taskId, { checkpointId: id, taskId, routeId, turnId: "", files });
        await appendDurable(taskId, [turnCheckpointedEvent({ checkpointId: id, routeId, turnId: "", files, clock })]);
        return id;
      });
      return { checkpointId };
    },

    async changeStatus(taskId, status) {
      if (!TASK_STATUSES.has(status)) {
        throw new TaskCommandError("invalid-request", `unknown task status: ${JSON.stringify(status)}`);
      }
      const routeId = (await stateOf(taskId)).activeRouteId;
      await withMutation(taskId, routeId, async () => {
        await appendDurable(taskId, [taskStatusEvent({ status: status as TaskStatus, clock })]);
      });
    },

    async append(taskId, event) {
      const routeId = (await stateOf(taskId)).activeRouteId;
      await withMutation(taskId, routeId, async () => {
        await appendDurable(taskId, [event]);
      });
    },
  };
}
