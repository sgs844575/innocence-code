// Shim: scope construction lives in the tools spine. The identity counters
// stay host-minted here: the spine barrel keeps them module-private, and
// session/route ids are minted by the host session. nextInvocationId
// delegates to the spine factory so invocation ids share ONE counter space
// with the loop (the spine's own default-parameter counter).
import { createExecutionScope } from "@innocencecode/harness-tools";

export { createExecutionScope };
export type { ExecutionScope, ExecutionScopeIdentity } from "@innocencecode/harness-tools";

let sessionSeq = 0;
let routeSeq = 0;

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

/** Monotonic, process-unique invocation id (invocation ids are never persisted). */
export function nextInvocationId(): string {
  return createExecutionScope("nextInvocationId").invocationId;
}
