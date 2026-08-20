/**
 * Apply/restore command bodies of the TaskCommandService (split out of
 * command-service.ts). Both multi-file writes into user-visible workspaces
 * run under the durable apply journal (storeBackedApplyJournal) — a mid-batch
 * crash leaves a rollback record the task-workspace recovery engine consumes.
 */
import { hunkReviewedEvent } from "./events";
import type { TaskEvent } from "./events";
import type { TaskIdClock } from "./ports";
import type { TaskState } from "./reducer";
import type { TaskApplyConflict, TaskApplyJournalHook, TaskCommandStore } from "./command-ports";
import { TaskCommandError } from "./command-ports";
import type { TaskCommandDeps } from "./command-types";
import { appendDurable, assertVersion, patchesOf, statusedHunks } from "./command-shared";

/**
 * Store-backed durable apply-journal hook: journals land in the task's
 * private apply-journal/ directory (writeArtifact writes storage-relative),
 * pre-transaction bytes back up into the task CAS — exactly what
 * task-workspace's recoverApplyJournals engine reads on restart recovery.
 * Exported so hosts and tests construct the identical hook.
 */
export function storeBackedApplyJournal(
  store: Pick<TaskCommandStore, "writeArtifact" | "putObject">,
  taskId: string,
): TaskApplyJournalHook {
  return {
    write: (journal) =>
      store.writeArtifact(taskId, `apply-journal/${journal.transactionId}.json`, JSON.stringify(journal)),
    backup: (_path, bytes) => store.putObject(taskId, bytes),
  };
}

/** restore(): reverts one hunk's file to the checkpoint state (version-guarded, journaled). */
export async function restoreHunk(
  deps: TaskCommandDeps,
  clock: TaskIdClock,
  request: {
    taskId: string;
    routeId: string;
    hunkRef: string;
    expectedVersion: string;
  },
  context: { events: TaskEvent[]; state: TaskState },
): Promise<void> {
  assertVersion(request.expectedVersion, context.events);
  const route = context.state.routes.get(request.routeId);
  if (route === undefined) {
    throw new TaskCommandError("route-not-found", `route not found: ${request.routeId} in task ${request.taskId}`);
  }
  const patches = await patchesOf(deps, request.taskId, context.state, route);
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
    // Journaled: restore reverts user-workspace bytes; a mid-batch death
    // must leave a rollback record the recovery engine can replay.
    journal: storeBackedApplyJournal(deps.store, request.taskId),
  });
  if (result.conflicts.length > 0) {
    throw new TaskCommandError("apply-conflict", `restore conflict at ${result.conflicts[0]!.path}`, result.conflicts);
  }
  await appendDurable(deps, request.taskId, [
    hunkReviewedEvent({ routeId: request.routeId, hunkRef: request.hunkRef, status: "restored", clock }),
  ]);
}

/**
 * applyAccepted(): writes every fully-accepted file of the route into the
 * ORIGINAL user workspace (isolated) or confirms the review (baseline).
 * The workspace lease covers the ACTUAL write target; the write loop runs
 * under the durable journal; dryRun routes to preflight only.
 */
export async function applyAcceptedFiles(
  deps: TaskCommandDeps,
  taskId: string,
  routeId: string,
  options: { dryRun?: boolean } | undefined,
  context: { events: TaskEvent[]; state: TaskState },
): Promise<{ applied: string[]; conflicts: TaskApplyConflict[] }> {
  const state = context.state;
  const route = state.routes.get(routeId);
  if (route === undefined) {
    throw new TaskCommandError("route-not-found", `route not found: ${routeId} in task ${taskId}`);
  }
  const patches = await patchesOf(deps, taskId, state, route);
  const hunks = await statusedHunks(deps, taskId, state, route, context.events);
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
  const baseline = JSON.parse(rawBaseline) as { root: string };
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
    // Journaled: the isolated apply writes into the ORIGINAL user
    // workspace; a mid-batch death must leave a rollback record instead
    // of a partially applied workspace with no trace (see apply-journal).
    journal: storeBackedApplyJournal(deps.store, taskId),
  };
  if (options?.dryRun) {
    const report = await deps.git.preflightApply(input);
    return { applied: [], conflicts: report.conflicts };
  }
  const result = await deps.git.applyAccepted(input);
  return { applied: result.applied, conflicts: result.conflicts };
}

/**
 * Lease-target resolution for applyAccepted BEFORE acquiring: isolated
 * apply's write target is the ORIGINAL user workspace (baseline root), not
 * the route worktree — that root is what the workspace lease must cover.
 */
export async function applyWorkspaceKey(
  deps: TaskCommandDeps,
  taskId: string,
  routeId: string,
  state: TaskState,
): Promise<string> {
  const route = state.routes.get(routeId);
  if (route === undefined) {
    throw new TaskCommandError("route-not-found", `route not found: ${routeId} in task ${taskId}`);
  }
  const isolated = state.mode === "isolated" && state.workspaceKind === "git";
  if (!isolated) return deps.workspace.canonicalKey(route.workspaceRoot);
  const rawBaseline = await deps.store.readArtifact(taskId, "baseline.json");
  if (rawBaseline === null) {
    throw new TaskCommandError("invalid-request", "baseline.json not found for isolated apply");
  }
  const baseline = JSON.parse(rawBaseline) as { root?: unknown };
  if (typeof baseline.root !== "string") {
    throw new TaskCommandError("invalid-request", "baseline.json has no root");
  }
  return deps.workspace.canonicalKey(baseline.root);
}
