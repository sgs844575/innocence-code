/**
 * Mutation lease runner of the TaskCommandService (split out of
 * command-service.ts): withMutation/withMutationAt acquire the task lease
 * FIRST and the workspace lease SECOND (the fixed order), re-read the event
 * log under the lease (the CAS basis), and release in reverse order. Lease
 * waits are bounded by deps.lockTimeoutMs.
 */
import type { TaskEvent } from "./events";
import { reduceTask, type TaskState } from "./reducer";
import { TaskCommandError, type TaskMutationLease } from "./command-ports";
import type { TaskCommandDeps } from "./command-types";
import { eventsOf, routeOf, stateOf } from "./command-shared";

export interface MutationRunner {
  /**
   * Runs `fn` under one mutation lease. The workspace key derives from the
   * ROUTE workspace (the default write target).
   */
  withMutation<T>(
    taskId: string,
    routeId: string,
    fn: (context: TaskMutationLease, events: TaskEvent[], state: TaskState) => Promise<T>,
  ): Promise<T>;
  /**
   * withMutation with an EXPLICIT workspace key — for mutations whose write
   * target is not the route workspace (isolated apply writes into the
   * ORIGINAL user workspace, so that root is what the lease must cover).
   */
  withMutationAt<T>(
    taskId: string,
    routeId: string,
    workspaceKey: string,
    fn: (context: TaskMutationLease, events: TaskEvent[], state: TaskState) => Promise<T>,
  ): Promise<T>;
}

export function createMutationRunner(
  deps: TaskCommandDeps,
  lockTimeoutMs: number,
): MutationRunner {
  async function withMutationAt<T>(
    taskId: string,
    routeId: string,
    workspaceKey: string,
    fn: (context: TaskMutationLease, events: TaskEvent[], state: TaskState) => Promise<T>,
  ): Promise<T> {
    routeOf(await stateOf(deps, taskId), routeId); // fail fast before touching locks
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), lockTimeoutMs);
    const acquire = async (label: string, run: () => Promise<AsyncDisposable>) => {
      try {
        return await run();
      } catch (error) {
        // Typed classification: only THIS mutation's own timeout signal maps
        // to lock-timeout; any other error (caller signal included, though the
        // service passes none) propagates unchanged.
        if (controller.signal.aborted) {
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
      const events = await eventsOf(deps, taskId);
      return await fn(context, events, reduceTask(events));
    } finally {
      if (workspaceLease !== undefined) {
        await Promise.resolve(workspaceLease[Symbol.asyncDispose]()).catch(() => undefined);
      }
      await Promise.resolve(taskLease[Symbol.asyncDispose]()).catch(() => undefined);
      clearTimeout(timer);
    }
  }

  return {
    async withMutation(taskId, routeId, fn) {
      const preState = await stateOf(deps, taskId);
      const route = routeOf(preState, routeId);
      const workspaceKey = await deps.workspace.canonicalKey(route.workspaceRoot);
      return withMutationAt(taskId, routeId, workspaceKey, fn);
    },
    withMutationAt,
  };
}
