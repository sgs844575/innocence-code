/**
 * Per-invocation execution scope. The executor constructs a fresh scope for
 * EVERY tool call — the invocation id is never reused, and a session-level
 * scope must never leak into a later invocation. Tools can use the scope for
 * correlated logging; it carries no arguments and is persistence-safe.
 */
export interface ExecutionScope {
  readonly invocationId: string;
  readonly toolName: string;
}

let invocationSeq = 0;

/** Monotonic, process-unique invocation id (invocation ids are never persisted). */
export function nextInvocationId(): string {
  invocationSeq += 1;
  return `inv-${invocationSeq}`;
}

/** Builds a frozen read-only scope; generates a fresh invocation id when omitted. */
export function createExecutionScope(
  toolName: string,
  invocationId: string = nextInvocationId(),
): ExecutionScope {
  return Object.freeze({ invocationId, toolName });
}
