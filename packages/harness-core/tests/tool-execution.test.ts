import { describe, expect, it } from "vitest";
import { createExecutionScope } from "../src/execution-scope";
import {
  DEFAULT_ABORT_GRACE_MS,
  TOOL_TIMEOUT,
  TOOL_UNSTABLE,
  ToolExecutionError,
  executeToolInvocation,
  isAbortError,
  toolErrorOutcome,
  type ToolExecutionInvocation,
  type ToolExecutionMiddleware,
  type ToolInvocation,
} from "../src/tool-execution";
import type { ToolContext, ToolResult } from "../src/tool";

function fakeInvocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    toolName: "Fake",
    persistedArgs: { safe: "value" },
    ctx: {
      workspaceRoot: "/tmp/ws",
      signal: new AbortController().signal,
      log: () => {},
      scope: createExecutionScope("Fake"),
    },
    ...overrides,
  };
}

const ok = (): ToolResult => ({ content: "ok" });

describe("executeToolInvocation", () => {
  it("wraps an allowed tool and finalizes after a result", async () => {
    const calls: string[] = [];
    const middleware: ToolExecutionMiddleware = {
      name: "record",
      async execute(_invocation, next) {
        calls.push("before");
        try {
          return await next();
        } finally {
          calls.push("finally");
        }
      },
    };

    const result = await executeToolInvocation(fakeInvocation(), [middleware], {
      timeoutMs: 100,
      execute: async () => {
        calls.push("tool");
        return { content: "done" };
      },
    });

    expect(result).toEqual({ content: "done" });
    expect(calls).toEqual(["before", "tool", "finally"]);
  });

  it("wraps an allowed tool and finalizes after an error", async () => {
    const calls: string[] = [];
    const middleware: ToolExecutionMiddleware = {
      name: "record",
      async execute(_invocation, next) {
        calls.push("before");
        try {
          return await next();
        } finally {
          calls.push("finally");
        }
      },
    };

    await expect(
      executeToolInvocation(fakeInvocation(), [middleware], {
        timeoutMs: 100,
        execute: async () => {
          calls.push("tool");
          throw new Error("failed");
        },
      }),
    ).rejects.toThrow("failed");

    expect(calls).toEqual(["before", "tool", "finally"]);
  });

  it("shows middleware the persisted args, invocation id and derived signal", async () => {
    const invocation = fakeInvocation({ persistedArgs: { command: "npm test" } });
    const seen: ToolExecutionInvocation[] = [];
    let bodySignal: AbortSignal | undefined;
    let bodyCtx: ToolContext | undefined;

    await executeToolInvocation(invocation, [
      {
        name: "spy",
        async execute(inv, next) {
          seen.push(inv);
          return next();
        },
      },
    ], {
      timeoutMs: 100,
      execute: async (signal, ctx) => {
        bodySignal = signal;
        bodyCtx = ctx;
        return ok();
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolName).toBe("Fake");
    expect(seen[0]!.persistedArgs).toEqual({ command: "npm test" });
    expect(seen[0]!.invocationId).toBe(invocation.ctx.scope.invocationId);
    expect(seen[0]!.signal.aborted).toBe(false);
    // The body gets the same derived signal plus the scoped context.
    expect(bodySignal).toBe(seen[0]!.signal);
    expect(bodyCtx?.scope.invocationId).toBe(invocation.ctx.scope.invocationId);
  });

  it("composes middleware with later registrations in the inner layer", async () => {
    const calls: string[] = [];
    const layer = (name: string): ToolExecutionMiddleware => ({
      name,
      async execute(_invocation, next) {
        calls.push(`before:${name}`);
        try {
          return await next();
        } finally {
          calls.push(`finally:${name}`);
        }
      },
    });

    await executeToolInvocation(fakeInvocation(), [layer("first"), layer("second")], {
      timeoutMs: 100,
      execute: async () => {
        calls.push("tool");
        return ok();
      },
    });

    expect(calls).toEqual(["before:first", "before:second", "tool", "finally:second", "finally:first"]);
  });

  it("propagates synchronous middleware throws as the rejection reason", async () => {
    let bodyRan = false;
    await expect(
      executeToolInvocation(fakeInvocation(), [
        {
          name: "sync-throw",
          execute(_invocation, _next) {
            throw new Error("sync middleware failure");
          },
        },
      ], {
        timeoutMs: 5,
        abortGraceMs: 5,
        execute: () => {
          bodyRan = true;
          return new Promise<ToolResult>(() => {});
        },
      }),
    ).rejects.toThrow("sync middleware failure");
    expect(bodyRan).toBe(false);
  });

  it("aborts the tool before reporting timeout", async () => {
    let aborted = false;
    await expect(
      executeToolInvocation(fakeInvocation(), [], {
        timeoutMs: 5,
        execute: async (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(signal.reason);
            });
          }),
      }),
    ).rejects.toMatchObject({ code: TOOL_TIMEOUT });
    expect(aborted).toBe(true);
  });

  it("still reports timeout when the body settles successfully after the abort", async () => {
    await expect(
      executeToolInvocation(fakeInvocation(), [], {
        timeoutMs: 5,
        execute: (signal) =>
          new Promise<ToolResult>((resolve) => {
            signal.addEventListener("abort", () => resolve({ content: "late" }), { once: true });
          }),
      }),
    ).rejects.toMatchObject({ code: TOOL_TIMEOUT, name: "ToolExecutionError" });
  });

  it("returns TOOL_UNSTABLE when the body ignores the abort past the grace window", async () => {
    await expect(
      executeToolInvocation(fakeInvocation(), [], {
        timeoutMs: 5,
        abortGraceMs: 5,
        // Never settles: the only escape is the unstable path.
        execute: () => new Promise<ToolResult>(() => {}),
      }),
    ).rejects.toMatchObject({ code: TOOL_UNSTABLE });
    expect(DEFAULT_ABORT_GRACE_MS).toBeGreaterThan(0);
  });

  it("propagates the parent abort reason to the tool", async () => {
    const parent = new AbortController();
    const invocation = fakeInvocation({ parentSignal: parent.signal });
    let sawReason: unknown;
    let caught: unknown;
    try {
      await executeToolInvocation(invocation, [], {
        timeoutMs: 1_000,
        execute: (signal) =>
          new Promise<ToolResult>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              sawReason = signal.reason;
              reject(signal.reason);
            }, { once: true });
            queueMicrotask(() => parent.abort());
          }),
      });
    } catch (err) {
      caught = err;
    }
    expect(isAbortError(caught)).toBe(true);
    expect(sawReason).toBe(parent.signal.reason);
  });

  it("applies the deadline to the whole middleware chain, not just the body", async () => {
    const calls: string[] = [];
    await expect(
      executeToolInvocation(fakeInvocation(), [
        {
          name: "slow",
          async execute(_invocation, next) {
            calls.push("before");
            await new Promise(() => {}); // blocks inside the middleware layer
            return next();
          },
        },
      ], {
        timeoutMs: 5,
        abortGraceMs: 5,
        execute: async () => {
          calls.push("tool");
          return ok();
        },
      }),
    ).rejects.toMatchObject({ code: TOOL_UNSTABLE });
    // The timeout owned the whole chain: the body was never reached.
    expect(calls).toEqual(["before"]);
  });
});

describe("tool outcome classification", () => {
  it("maps tool errors to standardized outcomes", () => {
    expect(toolErrorOutcome(new ToolExecutionError(TOOL_TIMEOUT, "t"))).toBe("timeout");
    expect(toolErrorOutcome(new ToolExecutionError(TOOL_UNSTABLE, "u"))).toBe("unstable");
    expect(toolErrorOutcome(new DOMException("Aborted", "AbortError"))).toBe("aborted");
    const named = new Error("stopped");
    named.name = "AbortError";
    expect(toolErrorOutcome(named)).toBe("aborted");
    expect(toolErrorOutcome(new Error("boom"))).toBe("error");
    expect(toolErrorOutcome("string")).toBe("error");
  });
});
