// TaskRuntimePort implementation over @innocencecode/task-workspace: the
// fixed task-lease → workspace-lease mutation contexts, CAS-guarded
// before/after captures (watcher-backed unknown-source detection) and the
// single event log appends. Pure Node — no Electron surface; the bridge
// (taskRuntimeBridge.ts) owns task lifecycle and wires this port into
// plugin-task's capture middleware.
import {
  canonicalWorkspaceKey,
  diskHash,
  type TaskMutationLock,
  type TaskRepository,
  type WorkspaceFileEvent,
  type WorkspaceWriteLock,
} from "@innocencecode/task-workspace";
import type {
  AfterCapture,
  AttributionDecision,
  BeforeCapture,
  CaptureAfterInput,
  CaptureBeforeInput,
  TaskEvent,
  TaskMutationContext,
  TaskRuntimePort,
  TaskScope,
  WorkspaceVersion,
} from "@innocencecode/plugin-task";

export interface TaskPortDeps {
  readonly taskId: string;
  /** Effective workspace the task operates in (worktree for isolated mode). */
  readonly workspaceRoot: string;
  readonly repository: TaskRepository;
  /** Lock pair in the FIXED acquire order: task lease first, workspace second. */
  readonly locks: { task: TaskMutationLock; workspace: WorkspaceWriteLock };
  /** Notified for every appended event (the bridge fans these out to hosts). */
  readonly onAppend?: (event: TaskEvent) => void;
  readonly log: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
}

/** Coalesced watcher observation: first before-state, last after-state. */
interface WindowChange {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
}

const WATCHER_SETTLE_POLL_MS = 10;
const WATCHER_SETTLE_MAX_POLLS = 25;

/**
 * One live task's port. A task is single-window by construction (the task
 * lease is exclusive), so one watcher buffer and window cursor serve every
 * capture; `markReleased()` fails every later mutation closed once the
 * bridge tears the task down.
 */
export class LiveTaskPort implements TaskRuntimePort {
  private readonly watcherEvents: WorkspaceFileEvent[] = [];
  private windowStart = 0;
  private readonly activeContexts = new Set<symbol>();
  private released = false;
  private readonly deps: TaskPortDeps;
  /** Watcher event sink the bridge hands to createWorkspaceWatcher. */
  readonly sink = (event: WorkspaceFileEvent): void => {
    this.watcherEvents.push(event);
  };

  constructor(deps: TaskPortDeps) {
    this.deps = deps;
  }

  markReleased(): void {
    this.released = true;
  }

  async acquireMutationContext(scope: TaskScope, signal?: AbortSignal): Promise<TaskMutationContext> {
    this.assertLive("acquireMutationContext");
    if (scope.taskId !== this.deps.taskId) {
      throw new Error(
        `task bridge: mutation scope task ${JSON.stringify(scope.taskId)} does not match live task ${JSON.stringify(this.deps.taskId)}`,
      );
    }
    // FIXED ORDER: task lease first, workspace lease second — never the
    // reverse (see task-workspace lock docs). Release order is reversed.
    const taskLease = await this.deps.locks.task.acquire(
      this.deps.taskId,
      { taskId: scope.taskId, routeId: scope.routeId },
      signal,
    );
    let workspaceLease: AsyncDisposable;
    try {
      const workspaceKey = await canonicalWorkspaceKey(this.deps.workspaceRoot);
      workspaceLease = await this.deps.locks.workspace.acquire(
        workspaceKey,
        { taskId: scope.taskId, routeId: scope.routeId },
        signal,
      );
      const leaseToken = Symbol(`task-lease:${this.deps.taskId}:${scope.routeId}`);
      this.activeContexts.add(leaseToken);
      return {
        taskId: this.deps.taskId,
        routeId: scope.routeId,
        workspaceKey,
        leaseToken,
        [Symbol.asyncDispose]: async () => {
          if (!this.activeContexts.delete(leaseToken)) return; // idempotent dispose
          try {
            await workspaceLease[Symbol.asyncDispose]();
          } finally {
            await taskLease[Symbol.asyncDispose]();
          }
        },
      };
    } catch (error) {
      await taskLease[Symbol.asyncDispose]();
      throw error;
    }
  }

  async readExpectedVersion(context: TaskMutationContext): Promise<WorkspaceVersion> {
    this.requireActive(context, "readExpectedVersion");
    return this.fingerprint();
  }

  async captureBefore(
    context: TaskMutationContext,
    input: CaptureBeforeInput,
  ): Promise<BeforeCapture> {
    this.requireActive(context, "captureBefore");
    this.windowStart = this.watcherEvents.length;
    const paths = await Promise.all(
      input.paths.map(async (p) => ({ path: p, hash: await diskHash(this.deps.workspaceRoot, p) })),
    );
    return { version: await this.fingerprint(), paths };
  }

  async captureAfter(
    context: TaskMutationContext,
    input: CaptureAfterInput,
  ): Promise<AfterCapture> {
    this.requireActive(context, "captureAfter");
    const version = await this.fingerprint();
    if (input.expectedVersion !== version) {
      throw new Error(
        `task bridge: workspace version moved (${input.expectedVersion} → ${version}) before captureAfter`,
      );
    }
    await this.settleWatcher();
    const declared = await Promise.all(
      input.paths.map(async (p) => ({ path: p, hash: await diskHash(this.deps.workspaceRoot, p) })),
    );
    // Watcher events of the window, coalesced per path. An event at a
    // declared path whose final hash matches the tool's captured after-state
    // is the tool's OWN write (already reported via changeRecorded from the
    // before/after diff) — only genuinely unknown-source changes surface.
    const byPath = new Map<string, WindowChange>();
    for (let i = this.windowStart; i < this.watcherEvents.length; i += 1) {
      const event = this.watcherEvents[i]!;
      const existing = byPath.get(event.path);
      byPath.set(event.path, {
        path: event.path,
        beforeHash: existing?.beforeHash ?? event.beforeHash,
        afterHash: event.afterHash,
      });
    }
    this.windowStart = this.watcherEvents.length;
    const declaredAfter = new Map(declared.map((entry) => [entry.path, entry.hash]));
    const unknown = [...byPath.values()]
      .filter((change) => declaredAfter.get(change.path) !== change.afterHash)
      .map((change) => ({ ...change, source: "unknown" as const }));
    return { version, declared, unknown };
  }

  async append(context: TaskMutationContext, event: TaskEvent): Promise<void> {
    this.requireActive(context, "append");
    await this.deps.repository.append([event]);
    this.deps.onAppend?.(event);
  }

  async requireAttribution(context: TaskMutationContext): Promise<AttributionDecision[]> {
    this.requireActive(context, "requireAttribution");
    return foldAttribution(await this.deps.repository.list());
  }

  private assertLive(method: string): void {
    if (this.released) {
      throw new Error(`task bridge: ${method} refused, task ${this.deps.taskId} is not live`);
    }
  }

  private requireActive(context: TaskMutationContext, method: string): void {
    this.assertLive(method);
    if (!this.activeContexts.has(context.leaseToken)) {
      throw new Error(`task bridge: ${method} requires an active TaskMutationContext`);
    }
  }

  /**
   * Opaque workspace version: a fingerprint of the task's event log. Under
   * the lease no other mutation of this task can append, so a mismatch at
   * captureAfter proves an outside writer moved the log — the CAS guard.
   */
  private async fingerprint(): Promise<WorkspaceVersion> {
    const events = await this.deps.repository.list();
    const last = events.at(-1);
    return `v${events.length}:${last?.eventId ?? ""}`;
  }

  /**
   * Bounded wait for the watcher to deliver pending events: polls until the
   * buffer stops growing for two consecutive polls (chokidar delivery is
   * asynchronous; the tool's write has usually landed by the time the
   * finally-block reaches captureAfter, but hashing/IO jitter needs slack).
   */
  private async settleWatcher(): Promise<void> {
    let lastSeen = this.watcherEvents.length;
    let stable = 0;
    for (let poll = 0; poll < WATCHER_SETTLE_MAX_POLLS && stable < 2; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, WATCHER_SETTLE_POLL_MS));
      if (this.watcherEvents.length === lastSeen) stable += 1;
      else {
        stable = 0;
        lastSeen = this.watcherEvents.length;
      }
    }
  }
}

/**
 * Folds the plugin events of one task log into attribution decisions
 * (plugin-task's state machine transitions, replayed from the single log):
 * pending → conflict may harden a path; resolved transitions land in their
 * terminal status. Hashes stay null when the persisted event carries none —
 * the gate (hasUnresolvedAttribution/unresolvedPaths) never reads them.
 */
export function foldAttribution(events: readonly TaskEvent[]): AttributionDecision[] {
  const decisions = new Map<string, AttributionDecision>();
  for (const event of events) {
    if (event.type === "attributionPending") {
      for (const path of event.paths) {
        decisions.set(path, {
          path,
          status: "attribution-pending",
          source: "unknown",
          beforeHash: null,
          afterHash: null,
          protectedHash: null,
        });
      }
    } else if (event.type === "attributionConflict") {
      for (const path of event.paths) {
        const prev = decisions.get(path);
        decisions.set(path, {
          path,
          status: "conflict",
          source: prev?.source ?? "unknown",
          beforeHash: prev?.beforeHash ?? null,
          afterHash: prev?.afterHash ?? null,
          protectedHash: null,
        });
      }
    } else if (event.type === "attributionResolved") {
      const prev = decisions.get(event.path);
      decisions.set(event.path, {
        path: event.path,
        status: event.status,
        source: prev?.source ?? "unknown",
        beforeHash: prev?.beforeHash ?? null,
        afterHash: prev?.afterHash ?? null,
        protectedHash: event.protectedHash,
      });
    }
  }
  return [...decisions.values()];
}
