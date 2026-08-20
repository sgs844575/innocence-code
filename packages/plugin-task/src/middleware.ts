import type {
  HarnessPlugin,
  Logger,
  Tool,
  ToolContext,
  ToolExecutionInvocation,
  ToolExecutionMiddleware,
  ToolResult,
  ToolSideEffect,
} from "@innocencecode/harness-core";
import {
  classifyUnknownChanges,
  hasUnresolvedAttribution,
  resolveAsExternal,
  resolveAsTaskOwned,
  unresolvedPaths,
  type Attribution,
  type AttributionDecision,
  type ChangeSource,
} from "./attribution";
import { asTaskScope, type BeforeCapture, type AfterCapture, type PathCapture, type TaskMutationContext, type TaskRuntimePort, type TaskScope } from "./scope";

/** Side-effect classes that can mutate workspace state → the middleware captures around them. */
const CAPTURED_SIDE_EFFECTS: readonly ToolSideEffect[] = ["paths", "process", "network", "unknown"];

/** Typed refusal marker for write tools blocked by unresolved attribution. */
export const ATTRIBUTION_BLOCKED = "attribution-blocked";

export interface AttributionBlockedResult extends ToolResult {
  readonly blocked: typeof ATTRIBUTION_BLOCKED;
  readonly paths: readonly string[];
}

/** The typed refusal outcome returned while attribution is unresolved. */
export function attributionBlockedResult(paths: readonly string[]): AttributionBlockedResult {
  return {
    content: `任务存在未归属的工作区变更（${[...paths].join("、")}）；用户确认归属前禁止新的写入工具`,
    isError: true,
    blocked: ATTRIBUTION_BLOCKED,
    paths: [...paths],
  };
}

export function isAttributionBlocked(result: ToolResult): result is AttributionBlockedResult {
  return (result as AttributionBlockedResult).blocked === ATTRIBUTION_BLOCKED;
}

export interface TaskCaptureOptions {
  /** Task runtime implementing capture/persist under the task → workspace locks. */
  readonly port: TaskRuntimePort;
  /**
   * Resolves the registered Tool behind an invocation. The middleware needs
   * the tool's side-effect class and path-kind permission resource; hosts
   * wire this to their registry (e.g. `(name) => registry.tools.get(name)`).
   */
  readonly lookupTool: (toolName: string) => Tool | undefined;
  /** Workspace root the permission resources are scoped against. */
  readonly workspaceRoot: string;
  readonly log?: Logger;
}

/**
 * Declared write targets of one invocation: the tool's canonical
 * PermissionResource when it is a write on a workspace path (kind "path",
 * action other than "read"). Derived from PERSISTED args — resources are
 * persistence-safe by contract, so the persisted copy yields the same target
 * the permission chain already saw; raw args never reach this middleware.
 */
async function declaredWritePaths(
  tool: Tool,
  invocation: ToolExecutionInvocation,
  options: TaskCaptureOptions,
): Promise<string[]> {
  const ctx: ToolContext = {
    workspaceRoot: options.workspaceRoot,
    signal: invocation.signal,
    log: options.log ?? (() => {}),
    scope: invocation.scope,
  };
  const resource = await tool.permissionResource(invocation.persistedArgs, ctx);
  return resource.kind === "path" && resource.action !== "read" ? [resource.scope] : [];
}

interface CapturedChange {
  readonly path: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
}

/** Paths whose hash moved between the before and after captures. */
function diffCaptured(before: readonly PathCapture[], after: readonly PathCapture[]): CapturedChange[] {
  const beforeByPath = new Map(before.map((capture) => [capture.path, capture.hash]));
  const changes: CapturedChange[] = [];
  for (const entry of after) {
    const beforeHash = beforeByPath.get(entry.path) ?? null;
    if (beforeHash !== entry.hash) {
      changes.push({ path: entry.path, beforeHash, afterHash: entry.hash });
    }
  }
  return changes;
}

/** Appends changeRecorded/attributionConflict/attributionPending for one capture window. */
async function appendCaptureEvents(
  port: TaskRuntimePort,
  context: TaskMutationContext,
  scope: TaskScope,
  before: BeforeCapture,
  after: AfterCapture,
  declaredPaths: readonly string[],
): Promise<void> {
  // Changes under a child scope (parentInvocationId set) are attributed to
  // the parent task exactly once, by the child's own capture — the parent's
  // delegated tool call never captures, so nothing is counted twice.
  const source: ChangeSource = scope.parentInvocationId === undefined ? "declared" : "delegated";
  for (const change of diffCaptured(before.paths, after.declared)) {
    await port.append(context, {
      type: "changeRecorded",
      path: change.path,
      source,
      beforeHash: change.beforeHash,
      afterHash: change.afterHash,
    });
  }
  const { conflicts, pending } = classifyUnknownChanges(after.unknown, declaredPaths);
  if (conflicts.length > 0) {
    await port.append(context, { type: "attributionConflict", paths: conflicts.map((change) => change.path) });
  }
  if (pending.length > 0) {
    await port.append(context, { type: "attributionPending", paths: pending.map((change) => change.path) });
  }
}

/**
 * The change-capture middleware. Fixed flow per captured (write-class,
 * task-scoped, non-delegated) invocation:
 *
 *   permission passed (the loop only reaches middleware after resolution) →
 *   acquireMutationContext (the port takes the task → workspace locks) →
 *   readExpectedVersion → attribution gate (blocked writes return a typed
 *   refusal and never capture) → captureBefore (declared paths only) →
 *   tool → FINALLY captureAfter (watcher + scans) → append events /
 *   pause for attribution → dispose the context (always, in a finally).
 *
 * Read-only, unregistered, non-task-scoped and delegated invocations pass
 * through untouched — delegated effects are audited by the child scope that
 * performs them, which is what keeps them single-counted.
 */
export function createTaskCaptureMiddleware(options: TaskCaptureOptions): ToolExecutionMiddleware {
  return {
    name: "task-change-capture",
    async execute(invocation, next) {
      const tool = options.lookupTool(invocation.toolName);
      if (tool === undefined) return next();
      const scope = asTaskScope(invocation.scope);
      if (scope === undefined) return next();
      if (tool.sideEffect === "delegated") return next();
      if (!CAPTURED_SIDE_EFFECTS.includes(tool.sideEffect ?? "none")) return next();

      const context = await options.port.acquireMutationContext(scope, invocation.signal);
      try {
        await options.port.readExpectedVersion(context);
        const decisions = await options.port.requireAttribution(context);
        if (hasUnresolvedAttribution(decisions)) {
          // New write tools stay blocked until the user attributes the changes.
          return attributionBlockedResult(unresolvedPaths(decisions));
        }

        const declaredPaths = await declaredWritePaths(tool, invocation, options);
        const before = await options.port.captureBefore(context, { paths: declaredPaths });
        try {
          const result = await next();
          return result;
        } finally {
          const after = await options.port.captureAfter(context, {
            paths: declaredPaths,
            expectedVersion: before.version,
          });
          await appendCaptureEvents(options.port, context, scope, before, after, declaredPaths);
        }
      } finally {
        await context[Symbol.asyncDispose]();
      }
    },
  };
}

/** Registers the change-capture middleware as a harness plugin. */
export function taskPlugin(options: TaskCaptureOptions): HarnessPlugin {
  return {
    name: "task-change-capture",
    activate(ctx) {
      ctx.registerToolMiddleware(createTaskCaptureMiddleware({ ...options, log: options.log ?? ctx.log }));
    },
  };
}

export interface AttributionResolution {
  readonly path: string;
  readonly attribution: Attribution;
}

/**
 * Applies one user attribution answer through the port: acquires a mutation
 * context (attribution state can only be mutated under a lease), loads the
 * tracked decisions, applies the pure transition and appends the
 * attributionResolved event. Resolving an untracked path fails closed.
 */
export async function resolveTaskAttribution(
  port: TaskRuntimePort,
  scope: TaskScope,
  resolution: AttributionResolution,
  signal?: AbortSignal,
): Promise<AttributionDecision> {
  const context = await port.acquireMutationContext(scope, signal);
  try {
    const decisions = await port.requireAttribution(context);
    const decision = decisions.find((candidate) => candidate.path === resolution.path);
    if (decision === undefined) {
      throw new Error(`task attribution: no decision tracked for ${resolution.path}`);
    }
    if (decision.status !== "attribution-pending") {
      throw new Error(
        `task attribution: ${resolution.path} is "${decision.status}", not attribution-pending`,
      );
    }
    const resolved =
      resolution.attribution === "task-owned" ? resolveAsTaskOwned(decision) : resolveAsExternal(decision);
    await port.append(context, {
      type: "attributionResolved",
      path: resolved.path,
      attribution: resolution.attribution,
      status: resolved.status,
      protectedHash: resolved.protectedHash,
    });
    return resolved;
  } finally {
    await context[Symbol.asyncDispose]();
  }
}
