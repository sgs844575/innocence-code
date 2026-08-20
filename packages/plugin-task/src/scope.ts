import type { ExecutionScope } from "@innocencecode/harness-core";
import type { AttributionDecision, ObservedChange } from "./attribution";
import type { TaskEvent } from "./events";

/**
 * An ExecutionScope narrowed to a task run: taskId and routeId become
 * REQUIRED. Composed from the P0 scope — nothing is copied or redefined;
 * absent identity on the base scope stays `undefined` (never null), and an
 * invocation without it simply is not task-scoped (see {@link asTaskScope}).
 */
export type TaskScope = ExecutionScope & {
  taskId: string;
  routeId: string;
};

/** Returns the scope as a TaskScope, or undefined when the invocation is not task-scoped. */
export function asTaskScope(scope: ExecutionScope): TaskScope | undefined {
  return typeof scope.taskId === "string" && typeof scope.routeId === "string"
    ? (scope as TaskScope)
    : undefined;
}

/**
 * Mutation lease for one tool invocation. Handed out by the runtime under the
 * fixed task → workspace lock order; every append/CAS/review/apply/recovery
 * call REQUIRES one — there is no contextless mutation overload. The lease
 * token is only ever compared by identity.
 */
export interface TaskMutationContext extends AsyncDisposable {
  readonly taskId: string;
  readonly routeId: string;
  readonly workspaceKey: string;
  readonly leaseToken: symbol;
}

/** Opaque workspace version token (CAS guard between expected and captured state). */
export type WorkspaceVersion = string;

/** Hash of one captured path; null = the path does not exist. */
export interface PathCapture {
  readonly path: string;
  readonly hash: string | null;
}

export interface CaptureBeforeInput {
  /** Declared write targets of this invocation (workspace-relative, "/"-separated). */
  readonly paths: readonly string[];
}

export interface BeforeCapture {
  readonly version: WorkspaceVersion;
  readonly paths: readonly PathCapture[];
}

export interface CaptureAfterInput {
  readonly paths: readonly string[];
  /** Version read before the tool ran; the runtime CAS-checks it. */
  readonly expectedVersion: WorkspaceVersion;
}

export interface AfterCapture {
  readonly version: WorkspaceVersion;
  /** Post-state of the declared targets. */
  readonly declared: readonly PathCapture[];
  /** Unknown-source changes seen by the watcher + workspace scans in the window. */
  readonly unknown: readonly ObservedChange[];
}

/**
 * Task runtime port. The real implementation (Task 6) persists events,
 * snapshots workspaces and takes the task → workspace locks inside
 * acquireMutationContext; the middleware only orchestrates it.
 */
export interface TaskRuntimePort {
  acquireMutationContext(scope: TaskScope, signal?: AbortSignal): Promise<TaskMutationContext>;
  readExpectedVersion(context: TaskMutationContext): Promise<WorkspaceVersion>;
  captureBefore(context: TaskMutationContext, input: CaptureBeforeInput): Promise<BeforeCapture>;
  captureAfter(context: TaskMutationContext, input: CaptureAfterInput): Promise<AfterCapture>;
  append(context: TaskMutationContext, event: TaskEvent): Promise<void>;
  requireAttribution(context: TaskMutationContext): Promise<AttributionDecision[]>;
}
