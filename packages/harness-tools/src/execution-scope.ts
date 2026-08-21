/**
 * Per-invocation execution scope. The executor constructs a fresh scope for
 * EVERY tool call — the invocation id is never reused, and a session-level
 * scope must never leak into a later invocation. Tools can use the scope for
 * correlated logging; it carries no arguments and is persistence-safe.
 *
 * Identity fields (sessionId/taskId/routeId/parentInvocationId) are inherited
 * from the run that minted the scope: a subagent session spawned by a `Task`
 * invocation keeps the parent's session/route/task identity and stamps the
 * parent invocation id, so hosts can correlate a child call back to its
 * spawning call.
 */
export interface ExecutionScope {
  readonly invocationId: string;
  readonly toolName: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly routeId?: string;
  readonly parentInvocationId?: string;
}

/**
 * Inherited identity shared by every invocation of one run. The session mints
 * it per `run()` (and subagent children derive theirs from the spawning
 * invocation); hosts may patch it through `AgentSession.run` options.
 */
export type ExecutionScopeIdentity = Partial<
  Pick<ExecutionScope, "sessionId" | "taskId" | "routeId" | "parentInvocationId">
>;

let invocationSeq = 0;
let sessionSeq = 0;
let routeSeq = 0;

/** Monotonic, process-unique invocation id (invocation ids are never persisted). */
export function nextInvocationId(): string {
  invocationSeq += 1;
  return `inv-${invocationSeq}`;
}

/** Monotonic session id, minted once per AgentSession. */
export function nextSessionId(): string {
  sessionSeq += 1;
  return `sess-${sessionSeq}`;
}

/** Monotonic route id, minted once per run (one user-initiated pass through the loop). */
export function nextRouteId(): string {
  routeSeq += 1;
  return `route-${routeSeq}`;
}

/**
 * Builds a frozen read-only scope; generates a fresh invocation id when
 * omitted and inherits the given run identity (never the invocation id
 * itself — every invocation gets its own).
 */
export function createExecutionScope(
  toolName: string,
  invocationId: string = nextInvocationId(),
  identity: ExecutionScopeIdentity = {},
): ExecutionScope {
  return Object.freeze({ invocationId, toolName, ...identity });
}
