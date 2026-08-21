import {
  createSpawnerPlugin,
  SUBAGENT_CONCURRENCY,
  type SpawnerChildMaterials,
  type SpawnerChildSession,
  type SpawnerDeps,
  type SpawnerLogger,
  type SpawnerRunInput,
  type SpawnerService,
  type SpawnerSessionFactory,
  type SubagentResult,
} from "@innocencecode/harness-agent";
import { Context } from "@innocencecode/kernel";
import { PermissionEngine } from "@innocencecode/harness-permissions";
import type { Provider } from "@innocencecode/harness-providers";
import type { MessageProcessor } from "@innocencecode/harness-session";
import {
  createExecutionScope,
  type ExecutionScopeIdentity,
  type Tool,
  type ToolExecutionMiddleware,
} from "@innocencecode/harness-tools";
import { describe, expect, it, vi } from "vitest";

// Service-level doubles: the spawner semantics are pinned through a
// sessionFactory test double that records what the service assembles.

const echoProvider: Provider = { id: "echo", async *chat() {} };

const allowEngine = () =>
  new PermissionEngine({ mode: "auto", decider: { ask: async () => "deny" as const } });

function fakeTool(name: string, readOnly = false): Tool {
  return {
    name,
    description: name,
    readOnly,
    sideEffect: readOnly ? ("none" as const) : ("unknown" as const),
    parameters: { type: "object" },
    permissionResource: () => ({
      action: readOnly ? "read" : "write",
      kind: "test",
      scope: name,
    }),
    persistArgs: (args) => ({ ...args }),
    async execute() {
      return { content: `${name}-done` };
    },
  };
}

const fakeProcessor = (name: string): MessageProcessor => ({
  name,
  order: 0,
  async process(message) {
    return message;
  },
});

const fakeMiddleware = (name: string): ToolExecutionMiddleware => ({
  name,
  async execute(_invocation, next) {
    return next();
  },
});

/** What the factory observed for one spawned child. */
interface ChildRecord {
  materials: SpawnerChildMaterials;
  runs: Array<{ prompt: string; signal: AbortSignal | undefined; identity: ExecutionScopeIdentity }>;
  disposeCalls: number;
}

/**
 * Factory double: every created child parks its run on a per-child gate the
 * test releases (`gates[i]()`), so concurrency windows are controllable.
 */
function makeFactory(
  script: { runResult?: SubagentResult; runError?: Error; disposeError?: Error } = {},
): { factory: SpawnerSessionFactory; children: ChildRecord[]; gates: Array<() => void> } {
  const children: ChildRecord[] = [];
  const gates: Array<() => void> = [];
  const factory: SpawnerSessionFactory = async (materials) => {
    const record: ChildRecord = { materials, runs: [], disposeCalls: 0 };
    children.push(record);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.push(release);
    const child: SpawnerChildSession = {
      run: async (prompt, signal, identity) => {
        record.runs.push({ prompt, signal, identity });
        await gate;
        if (script.runError) throw script.runError;
        return script.runResult ?? { finalText: "子代理报告", turns: 1 };
      },
      dispose: async () => {
        record.disposeCalls += 1;
        if (script.disposeError) throw script.disposeError;
      },
    };
    return child;
  };
  return { factory, children, gates };
}

/** Loads the spawner plugin into a fresh kernel context. */
async function withSpawner(overrides: Partial<SpawnerDeps> = {}): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(
    createSpawnerPlugin({
      sessionFactory: makeFactory().factory,
      provider: echoProvider,
      permission: allowEngine(),
      tools: [],
      ...overrides,
    }),
  );
  return ctx;
}

const baseInput: SpawnerRunInput = {
  systemPrompt: "只读研究代理",
  prompt: "去查",
  tools: "all",
  inherit: { processors: [], middlewares: [] },
};

/** Runs one spawn through the service and releases the parked child. */
async function runOne(
  ctx: Context,
  gates: Array<() => void>,
  input: SpawnerRunInput = baseInput,
): Promise<SubagentResult> {
  const pending = ctx.spawner.run(input);
  await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(1));
  gates.shift()!();
  return pending;
}

describe("spawner child plugin set construction", () => {
  it("selects child tools from the parent set and always excludes Task", async () => {
    const task = fakeTool("Task");
    const read = fakeTool("Read", true);
    const write = fakeTool("Write");
    const seek = fakeTool("Seek", true);
    const { factory, children, gates } = makeFactory();
    const ctx = await withSpawner({
      sessionFactory: factory,
      tools: [task, read, write, seek],
    });

    // Named selection keeps the parent registration order.
    await runOne(ctx, gates, { ...baseInput, tools: ["Write", "Read"] });
    expect(children[0]!.materials.tools).toEqual([read, write]);
    // "all" takes everything except Task itself.
    await runOne(ctx, gates, { ...baseInput, tools: "all" });
    expect(children[1]!.materials.tools).toEqual([read, write, seek]);
    // "readOnly" keeps only readOnly tools, Task still excluded.
    await runOne(ctx, gates, { ...baseInput, tools: "readOnly" });
    expect(children[2]!.materials.tools).toEqual([read, seek]);
    // Unknown names drop out silently (the original filter semantics).
    await runOne(ctx, gates, { ...baseInput, tools: ["Read", "Ghost"] });
    expect(children[3]!.materials.tools).toEqual([read]);
    expect(children.some((c) => c.materials.tools.includes(task))).toBe(false);
  });

  it("passes the inherited processors and middlewares through unchanged, in order", async () => {
    const p1 = fakeProcessor("p1");
    const p2 = fakeProcessor("p2");
    const m1 = fakeMiddleware("m1");
    const m2 = fakeMiddleware("m2");
    const { factory, children, gates } = makeFactory();
    const ctx = await withSpawner({ sessionFactory: factory });

    await runOne(ctx, gates, {
      ...baseInput,
      inherit: { processors: [p1, p2], middlewares: [m1, m2] },
    });

    // Same objects, same order — the child registers the parent's set as-is.
    expect(children[0]!.materials.processors).toHaveLength(2);
    expect(children[0]!.materials.processors[0]).toBe(p1);
    expect(children[0]!.materials.processors[1]).toBe(p2);
    expect(children[0]!.materials.middlewares).toHaveLength(2);
    expect(children[0]!.materials.middlewares[0]).toBe(m1);
    expect(children[0]!.materials.middlewares[1]).toBe(m2);
  });

  it("shares the parent provider and permission engine with the child", async () => {
    const provider: Provider = { id: "shared", async *chat() {} };
    const permission = allowEngine();
    const { factory, children, gates } = makeFactory();
    const ctx = await withSpawner({ sessionFactory: factory, provider, permission });

    await runOne(ctx, gates);

    // The very instances are handed over — shared rules, grants and mode.
    expect(children[0]!.materials.provider).toBe(provider);
    expect(children[0]!.materials.permission).toBe(permission);
  });

  it("defaults the child maxTurns to 20 and honors an explicit cap", async () => {
    const { factory, children, gates } = makeFactory();
    const ctx = await withSpawner({ sessionFactory: factory });

    await runOne(ctx, gates);
    expect(children[0]!.materials.maxTurns).toBe(20);
    await runOne(ctx, gates, { ...baseInput, maxTurns: 7 });
    expect(children[1]!.materials.maxTurns).toBe(7);
  });

  it("passes the spawn system prompt to the child materials", async () => {
    const { factory, children, gates } = makeFactory();
    const ctx = await withSpawner({ sessionFactory: factory });

    await runOne(ctx, gates, { ...baseInput, systemPrompt: "规划子代理" });
    expect(children[0]!.materials.systemPrompt).toBe("规划子代理");
  });
});

describe("spawner run semantics", () => {
  it("runs the child prompt and signal under the parent-derived identity", async () => {
    const { factory, children, gates } = makeFactory();
    const ctx = await withSpawner({ sessionFactory: factory });
    const parentScope = createExecutionScope("Task", "inv-9", {
      sessionId: "sess-1",
      taskId: "task-9",
      routeId: "route-4",
    });
    const signal = new AbortController().signal;

    await runOne(ctx, gates, { ...baseInput, parentScope, signal });
    expect(children[0]!.runs).toHaveLength(1);
    expect(children[0]!.runs[0]!.prompt).toBe("去查");
    expect(children[0]!.runs[0]!.signal).toBe(signal);
    expect(children[0]!.runs[0]!.identity).toEqual({
      sessionId: "sess-1",
      taskId: "task-9",
      routeId: "route-4",
      parentInvocationId: "inv-9",
    });

    // Without a parent scope the identity falls back to the input's sessionId.
    await runOne(ctx, gates, { ...baseInput, sessionId: "sess-host" });
    expect(children[1]!.runs[0]!.identity).toEqual({ sessionId: "sess-host" });
  });

  it("returns the child run summary as the subagent result", async () => {
    const { factory, gates } = makeFactory({
      runResult: { finalText: "子代理报告：找到了", turns: 3 },
    });
    const ctx = await withSpawner({ sessionFactory: factory });

    await expect(runOne(ctx, gates)).resolves.toEqual({
      finalText: "子代理报告：找到了",
      turns: 3,
    });
  });
});

describe("spawner concurrency cap", () => {
  it("caps concurrent spawns and frees the slot once a child settles", async () => {
    const { factory, children, gates } = makeFactory();
    const ctx = await withSpawner({ sessionFactory: factory });

    const first = ctx.spawner.run(baseInput);
    const second = ctx.spawner.run(baseInput);
    const third = ctx.spawner.run(baseInput);
    await vi.waitFor(() => expect(children).toHaveLength(3));
    await expect(ctx.spawner.run(baseInput)).rejects.toThrow(
      `子代理并发已达上限（${SUBAGENT_CONCURRENCY}），请稍后再派生`,
    );

    gates[0]!();
    await first;
    // The settled child released its slot: a fourth spawn is admitted.
    const fourth = ctx.spawner.run(baseInput);
    await vi.waitFor(() => expect(children).toHaveLength(4));
    gates[1]!();
    gates[2]!();
    gates[3]!();
    await Promise.all([second, third, fourth]);
    expect(children.every((c) => c.disposeCalls === 1)).toBe(true);
  });

  it("honors an injected concurrency cap", async () => {
    const { factory, children, gates } = makeFactory();
    const ctx = await withSpawner({ sessionFactory: factory, concurrency: 1 });

    const first = ctx.spawner.run(baseInput);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    await expect(ctx.spawner.run(baseInput)).rejects.toThrow(
      "子代理并发已达上限（1），请稍后再派生",
    );

    gates[0]!();
    await first;
    expect(children).toHaveLength(1);
  });

  it("releases the slot when the child run fails", async () => {
    const { factory, gates } = makeFactory({ runError: new Error("run-boom") });
    const ctx = await withSpawner({ sessionFactory: factory, concurrency: 1 });

    const first = ctx.spawner.run(baseInput);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]!();
    await expect(first).rejects.toThrow("run-boom");

    // The failed child released its slot: the next spawn is admitted.
    const second = ctx.spawner.run(baseInput);
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]!();
    await expect(second).rejects.toThrow("run-boom");
  });
});

describe("spawner child disposal", () => {
  it("disposes the child in a finally after a successful run, swallowing dispose errors", async () => {
    const disposeError = new Error("dispose-boom");
    const logs: Array<{ level: string; msg: string; data?: unknown }> = [];
    const logger: SpawnerLogger = (level, msg, data) => logs.push({ level, msg, data });
    const { factory, children, gates } = makeFactory({ disposeError });
    const ctx = await withSpawner({ sessionFactory: factory, logger });

    await expect(runOne(ctx, gates)).resolves.toEqual({ finalText: "子代理报告", turns: 1 });
    expect(children[0]!.disposeCalls).toBe(1);
    // The swallowed dispose failure is still reported through the logger.
    expect(logs).toContainEqual({
      level: "error",
      msg: "subagent child dispose failed",
      data: disposeError,
    });
  });

  it("never masks the child run's original error with a dispose failure", async () => {
    const disposeError = new Error("dispose-boom");
    const logs: Array<{ level: string; msg: string }> = [];
    const logger: SpawnerLogger = (level, msg) => logs.push({ level, msg });
    const { factory, children, gates } = makeFactory({
      runError: new Error("run-boom"),
      disposeError,
    });
    const ctx = await withSpawner({ sessionFactory: factory, logger });

    await expect(runOne(ctx, gates)).rejects.toThrow("run-boom");
    expect(children[0]!.disposeCalls).toBe(1);
    expect(logs).toContainEqual({ level: "error", msg: "subagent child dispose failed" });
  });
});

describe("spawner service lifecycle on the kernel", () => {
  it("carries the plugin name \"harness-spawner\"", () => {
    const plugin = createSpawnerPlugin({
      sessionFactory: makeFactory().factory,
      provider: echoProvider,
      permission: allowEngine(),
      tools: [],
    });
    expect(plugin.name).toBe("harness-spawner");
  });

  it("publishes the service under \"spawner\" while its fiber is active", async () => {
    const ctx = await withSpawner();
    expect((ctx as { spawner?: SpawnerService }).spawner).toBeDefined();
    expect(typeof ctx.spawner.run).toBe("function");
  });

  it("withdraws the service when the plugin fiber is disposed", async () => {
    const ctx = new Context();
    const { factory, gates } = makeFactory();
    const fiber = await ctx.plugin(
      createSpawnerPlugin({
        sessionFactory: factory,
        provider: echoProvider,
        permission: allowEngine(),
        tools: [],
      }),
    );
    const service = ctx.spawner;
    expect((ctx as { spawner?: SpawnerService }).spawner).toBeDefined();
    await fiber.dispose();
    expect((ctx as { spawner?: SpawnerService }).spawner).toBeUndefined();
    // The detached service object stays usable (its concurrency slot lives on).
    const pending = service.run(baseInput);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]!();
    await expect(pending).resolves.toEqual({ finalText: "子代理报告", turns: 1 });
  });
});
