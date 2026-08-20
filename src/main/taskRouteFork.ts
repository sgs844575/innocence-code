import fs from "node:fs/promises";
import path from "node:path";
import {
  createRoute,
  forkFromUserMessage,
  reduceTask,
  retryAssistantTurn,
  routeAttachedEvent,
  toTaskHead,
  type Route,
  type RouteAttachedEvent,
} from "@innocencecode/task-core";
import type { GitAdapter, GitBaseline, WorktreeLease } from "@innocencecode/task-git";
import type { TaskMutationLock, TaskRepository } from "@innocencecode/task-workspace";

export interface ForkRouteInput {
  sessionId: string;
  taskId: string;
  sourceRouteId: string;
  sourceTurnId: string;
  mode: "edit-user" | "retry-assistant";
  editedText?: string;
  routeName: string;
}

export interface TaskRouteForkDeps {
  repository: TaskRepository;
  git: GitAdapter;
  taskLock: TaskMutationLock;
  baseline: GitBaseline;
  userWorkspaceRoot: string;
  worktreeDir: string;
  mintRouteId(): string;
  /** Starts route-scoped runtime resources before the route becomes durable. */
  prepareRoute?(route: Route, lease: WorktreeLease): Promise<() => Promise<void>>;
}

export async function createForkedTaskRoute(
  deps: TaskRouteForkDeps,
  input: ForkRouteInput,
): Promise<{ route: Route; event: RouteAttachedEvent; lease: WorktreeLease; prompt: string }> {
  const taskLease = await deps.taskLock.acquire(input.taskId, {
    taskId: input.taskId,
    routeId: input.sourceRouteId,
  });
  let lease: WorktreeLease | undefined;
  let rollbackPrepared: (() => Promise<void>) | undefined;
  let restoreHead: (() => Promise<void>) | undefined;
  try {
    const beforeEvents = await deps.repository.list();
    const state = reduceTask(beforeEvents);
    if (state.sessionId !== input.sessionId) throw new Error("fork route session mismatch");
    const request = input.mode === "edit-user"
      ? forkFromUserMessage(state, {
          routeId: input.sourceRouteId,
          turnId: input.sourceTurnId,
          editedText: input.editedText ?? "",
        })
      : retryAssistantTurn(state, { routeId: input.sourceRouteId, turnId: input.sourceTurnId });
    const source = state.routes.get(input.sourceRouteId)!;
    if (!source.baseCommit) throw new Error("source route immutable baseCommit is missing");
    const checkpoint = await deps.repository.readCheckpoint(request.checkpointId);
    if (!checkpoint) throw new Error(`checkpoint not found: ${request.checkpointId}`);

    const routeId = deps.mintRouteId();
    const routePath = path.join(deps.worktreeDir, input.taskId, routeId);
    lease = await deps.git.createWorktree({
      root: deps.userWorkspaceRoot,
      path: routePath,
      baseCommit: source.baseCommit,
    });
    await deps.git.overlayBaseline(lease, deps.baseline);
    const recovered = await deps.git.recoverWorktree({
      root: deps.userWorkspaceRoot,
      path: routePath,
      baseCommit: source.baseCommit,
      baseline: deps.baseline,
      checkpointFiles: checkpoint.files.map((file) => ({ path: file.path, hash: file.hash })),
      readContent: (hash) => deps.repository.objects.get(hash),
    });

    // Validate every target path/hash before making the route durable or visible.
    for (const file of checkpoint.files) {
      const target = path.join(recovered.path, ...file.path.split("/"));
      if (file.hash === null) {
        await fs.access(target).then(
          () => { throw new Error(`fork validation expected absent path: ${file.path}`); },
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          },
        );
      } else {
        const bytes = new Uint8Array(await fs.readFile(target));
        const stored = await deps.repository.objects.get(file.hash);
        if (!Buffer.from(bytes).equals(Buffer.from(stored))) {
          throw new Error(`fork validation hash mismatch: ${file.path}`);
        }
      }
    }

    const route = createRoute({
      routeId,
      parentRouteId: request.parentRouteId,
      forkTurnId: request.sourceTurnId,
      checkpointId: request.checkpointId,
      workspaceRoot: recovered.path,
      baseCommit: source.baseCommit,
    });
    const attached = routeAttachedEvent({ route });
    const nextHead = toTaskHead(reduceTask([...beforeEvents, attached]));
    rollbackPrepared = await deps.prepareRoute?.(route, recovered);
    // Atomic exposure boundary: event append is last. If it fails, restore the
    // previous projected head before cleaning the route's runtime resources.
    await deps.repository.writeTaskHead(nextHead);
    restoreHead = () => deps.repository.writeTaskHead(toTaskHead(state));
    await deps.repository.append([attached]);
    restoreHead = undefined;
    rollbackPrepared = undefined;
    return { route, event: attached, lease: recovered, prompt: request.prompt };
  } catch (error) {
    await restoreHead?.().catch(() => undefined);
    await rollbackPrepared?.().catch(() => undefined);
    if (lease) await deps.git.destroyWorktree(lease).catch(() => undefined);
    throw error;
  } finally {
    await taskLease[Symbol.asyncDispose]();
  }
}
