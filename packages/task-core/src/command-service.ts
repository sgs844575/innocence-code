/**
 * The ONE host-agnostic TaskCommandService (Task 13). Every command of the
 * fixed method set orchestrates the ports declared in command-ports.ts; every
 * mutation acquires its TaskMutationLease INSIDE this service (task lease →
 * workspace lease, the fixed order) and enforces ownership, expectedVersion
 * CAS and the completion/attribution gates here. Adapters (Electron IPC
 * handlers, the CLI adapter in @innocencecode/task-cli) only delegate — they
 * never touch task storage directly.
 *
 * Split by responsibility (public surface unchanged — every name below is
 * re-exported from this module exactly as before):
 *   command-types.ts   public DTOs, service/deps interfaces, constants
 *   command-shared.ts  event-log/route/CAS helpers, patches, statused hunks
 *   command-lease.ts   withMutation/withMutationAt lease runner
 *   command-gates.ts   completion gate computation + override
 *   command-start.ts   start() body (baseline capture, worktree, checkpoint)
 *   command-apply.ts   restore()/applyAccepted() bodies + journal hook
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
  taskStatusEvent,
  turnCheckpointedEvent,
  type TaskEvent,
} from "./events";
import { createNodeIdClock } from "./ports";
import { reduceTask } from "./reducer";
import type { Route, TaskStatus } from "./model";
import type { TaskMutationLease } from "./command-ports";
import { TaskCommandError } from "./command-ports";
import {
  appendDurable,
  assertVersion,
  eventsOf,
  forkWith,
  patchesOf,
  routeOf,
  stateOf,
  statusedHunks,
  withUnreviewed,
} from "./command-shared";
import { createMutationRunner } from "./command-lease";
import { evaluateCompletionGate, throwIfBlocked } from "./command-gates";
import { startTask } from "./command-start";
import { applyAcceptedFiles, applyWorkspaceKey, restoreHunk } from "./command-apply";
import {
  DEFAULT_LOCK_TIMEOUT_MS,
  isGitInternal,
  TASK_STATUSES,
  type TaskCommandDeps,
  type TaskCommandService,
} from "./command-types";

export { TaskCommandError } from "./command-ports";
export {
  TASK_COMMAND_METHODS,
  TASK_STATUSES,
  TASK_ID_PATTERN,
  DEFAULT_LOCK_TIMEOUT_MS,
  isGitInternal,
  versionOf,
  routeSummary,
} from "./command-types";
export type {
  TaskStartCommand,
  TaskGetResult,
  TaskRouteSummaryDto,
  TaskForkResult,
  CompletionGateDto,
  TaskCommandService,
  TaskCommandDeps,
} from "./command-types";
export { storeBackedApplyJournal } from "./command-apply";
export type { TaskApplyJournalHook, TaskApplyJournalRecord, TaskApplyJournalEntry } from "./command-ports";

export function createTaskCommandService(deps: TaskCommandDeps): TaskCommandService {
  const clock = deps.clock ?? createNodeIdClock();
  const log = deps.log ?? (() => {});
  const lockTimeoutMs = deps.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const mutations = createMutationRunner(deps, lockTimeoutMs);

  return {
    async start(request) {
      return startTask(deps, clock, request);
    },

    async get(taskId) {
      return withUnreviewed(deps, taskId, await stateOf(deps, taskId));
    },

    async getChanges(taskId, routeId) {
      const state = await stateOf(deps, taskId);
      return patchesOf(deps, taskId, state, routeOf(state, routeId));
    },

    async getCheckpoint(taskId, checkpointId) {
      await eventsOf(deps, taskId);
      return deps.store.readCheckpoint(taskId, checkpointId);
    },

    async listRoutes(taskId) {
      const state = await stateOf(deps, taskId);
      return [...state.routes.values()].map((route: Route) => ({
        routeId: route.routeId,
        parentRouteId: route.parentRouteId,
        forkTurnId: route.forkTurnId,
        checkpointId: route.checkpointId,
        workspaceKind: state.workspaceKind,
      }));
    },

    async switchRoute(taskId, routeId) {
      return mutations.withMutation(taskId, routeId, async (_context: TaskMutationLease, events: TaskEvent[]) => {
        const state = reduceTask(events);
        const route = routeOf(state, routeId);
        await appendDurable(deps, taskId, [activeRouteChangedEvent({ routeId, clock })]);
        return {
          routeId: route.routeId,
          parentRouteId: route.parentRouteId,
          forkTurnId: route.forkTurnId,
          checkpointId: route.checkpointId,
          workspaceKind: state.workspaceKind,
        };
      });
    },

    async forkFromUser(request) {
      return forkWith(
        deps,
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
        deps,
        request,
        (state) => retryAssistantTurn(state, {
          routeId: request.sourceRouteId,
          turnId: request.sourceTurnId,
        }),
        "retry-assistant",
      );
    },

    async listHunks(taskId, routeId) {
      const state = await stateOf(deps, taskId);
      const route = routeOf(state, routeId);
      return statusedHunks(deps, taskId, state, route, await eventsOf(deps, taskId));
    },

    async review(request) {
      await mutations.withMutation(request.taskId, request.routeId, async (_context, events, state) => {
        assertVersion(request.expectedVersion, events);
        const route = routeOf(state, request.routeId);
        const hunks = await statusedHunks(deps, request.taskId, state, route, events);
        if (!hunks.some((hunk) => hunk.ref === request.hunkRef)) {
          throw new TaskCommandError("hunk-not-found", `hunk not found: ${request.hunkRef}`);
        }
        await appendDurable(deps, request.taskId, [
          hunkReviewedEvent({ routeId: request.routeId, hunkRef: request.hunkRef, status: request.status, clock }),
        ]);
      });
    },

    async restore(request) {
      await mutations.withMutation(request.taskId, request.routeId, async (_context, events, state) => {
        await restoreHunk(deps, clock, request, { events, state });
      });
    },

    async attributeUnknown(taskId, path, attribution) {
      await mutations.withMutation(taskId, (await stateOf(deps, taskId)).activeRouteId, async (_context, events) => {
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
        await appendDurable(deps, taskId, [{
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
      await mutations.withMutation(request.taskId, request.routeId, async (_context, events) => {
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
        await appendDurable(deps, request.taskId, [
          conflictResolvedEvent({ path: request.path, attribution: request.attribution, clock }),
        ]);
      });
    },

    async validate(taskId, routeId) {
      const state = await stateOf(deps, taskId);
      const route = routeOf(state, routeId);
      return deps.validator
        ? deps.validator(taskId, routeId, route.workspaceRoot)
        : { success: true };
    },

    async complete(request) {
      // The WHOLE gate evaluation runs under the mutation lease: a concurrent
      // review/resolve cannot slip between the read and the decision, so the
      // gate can never be computed from stale state.
      await mutations.withMutation(request.taskId, (await stateOf(deps, request.taskId)).activeRouteId,
        async (_context, events, state) => {
          const route = routeOf(state, state.activeRouteId);
          const outcome = await evaluateCompletionGate({
            deps, clock, taskId: request.taskId, state, events, route,
            confirmValidationFailure: request.confirmValidationFailure,
          });
          throwIfBlocked(outcome);
        });
    },

    async applyAccepted(taskId, routeId, options) {
      // Lease target resolution BEFORE acquiring (see applyWorkspaceKey).
      const workspaceKey = await applyWorkspaceKey(deps, taskId, routeId, await stateOf(deps, taskId));
      return mutations.withMutationAt(taskId, routeId, workspaceKey, async (_context, events, state) =>
        applyAcceptedFiles(deps, taskId, routeId, options, { events, state }));
    },

    async recover(taskId) {
      // Leased: recovery replays worktrees/checkpoints and must serialize
      // against in-flight mutations of the same task.
      const activeRouteId = (await stateOf(deps, taskId)).activeRouteId;
      const state = await mutations.withMutation(taskId, activeRouteId, async () =>
        deps.recover.recoverTask(taskId));
      return withUnreviewed(deps, taskId, state);
    },

    async delete(taskId) {
      // Leased: deletion destroys worktrees and storage; a concurrent mutation
      // of the same task must never interleave with it.
      const activeRouteId = (await stateOf(deps, taskId)).activeRouteId;
      await mutations.withMutation(taskId, activeRouteId, async () => {
        await deps.delete.deleteTask(taskId);
        log("info", "task deleted", { taskId });
      });
    },

    async recoveryWarnings(taskId) {
      const state = await stateOf(deps, taskId);
      return [...state.turns.values()]
        .filter((turn) => turn.phase === "prepared")
        .map((turn) => `turn ${turn.turnId} is prepared but not committed`);
    },

    // -- Host escape hatches beyond the fixed set ---------------------------

    async createCheckpoint(taskId, routeId) {
      const checkpointId = await mutations.withMutation(taskId, routeId, async () => {
        const state = reduceTask(await eventsOf(deps, taskId));
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
        await appendDurable(deps, taskId, [turnCheckpointedEvent({ checkpointId: id, routeId, turnId: "", files, clock })]);
        return id;
      });
      return { checkpointId };
    },

    async changeStatus(taskId, status) {
      if (!TASK_STATUSES.has(status)) {
        throw new TaskCommandError("invalid-request", `unknown task status: ${JSON.stringify(status)}`);
      }
      const routeId = (await stateOf(deps, taskId)).activeRouteId;
      await mutations.withMutation(taskId, routeId, async () => {
        await appendDurable(deps, taskId, [taskStatusEvent({ status: status as TaskStatus, clock })]);
      });
    },

    async append(taskId, event) {
      const routeId = (await stateOf(deps, taskId)).activeRouteId;
      await mutations.withMutation(taskId, routeId, async () => {
        await appendDurable(deps, taskId, [event]);
      });
    },
  };
}
