/**
 * Task start command body of the TaskCommandService (split out of
 * command-service.ts): git detection (fail-closed isolated), baseline
 * capture + durable artifact, isolated worktree creation/overlay, baseline
 * checkpoint (content before manifest) and the taskCreated event. A partial
 * start destroys its own worktree — no orphan can survive a failed attempt.
 */
import { taskCreatedEvent } from "./events";
import { reduceTask, toTaskHead } from "./reducer";
import type { TaskIdClock } from "./ports";
import type { TaskCommandDeps, TaskStartCommand } from "./command-types";
import { isGitInternal, TASK_ID_PATTERN } from "./command-types";
import { TaskCommandError } from "./command-ports";
import type { TaskStartedInfo } from "./command-ports";
import type { WorkspaceKind } from "./model";
import { appendDurable } from "./command-shared";

export async function startTask(
  deps: TaskCommandDeps,
  clock: TaskIdClock,
  request: TaskStartCommand,
): Promise<TaskStartedInfo> {
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
    await appendDurable(deps, taskId, [created]);
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
}
