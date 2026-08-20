import {
  AgentSession,
  createExecutionScope,
  sha256Hex,
  type Delta,
  type HarnessPlugin,
  type Provider,
  type Tool,
} from "@innocencecode/harness-core";
import {
  hasUnresolvedAttribution,
  resolveAsExternal,
  resolveAsTaskOwned,
  taskPlugin,
  toAttributionPending,
  type AttributionDecision,
  type ObservedChange,
} from "../src";
import type {
  AfterCapture,
  BeforeCapture,
  CaptureAfterInput,
  CaptureBeforeInput,
  ChangeRecordedEvent,
  TaskEvent,
  TaskMutationContext,
  TaskRuntimePort,
  TaskScope,
  WorkspaceVersion,
} from "../src";

/**
 * In-memory TaskRuntimePort fake: the middleware's only collaborator. It
 * simulates the workspace as a path→content table, drains a watcher-style
 * observation queue on captureAfter, folds appended events into attribution
 * decisions/task status (the way Task 6's persisted runtime will) and records
 * the port call order for the fixed-flow assertions.
 */
export type FakeTaskStatus = "running" | "paused" | "review";

export interface FakeTaskRuntime extends TaskRuntimePort {
  /** Every appended task event, in append order. */
  readonly events: TaskEvent[];
  /** changeRecorded events only (one per captured path change). */
  readonly changeEvents: ChangeRecordedEvent[];
  /** Ordered port call log (method names, "dispose" included). */
  readonly calls: string[];
  /** Attribution decisions folded from appended events. */
  readonly decisions: AttributionDecision[];
  status: FakeTaskStatus;
  /** Mutation contexts acquired but not yet disposed. */
  readonly openContexts: number;
  /** Simulated workspace write (what a tool's effect looks like). */
  writeFile(path: string, content: string): void;
  /** Replaces the watcher/scan observation queue drained by the next captureAfter. */
  setObservedChanges(changes: readonly ObservedChange[]): void;
}

export interface FakeTaskRuntimeInit {
  files?: Record<string, string>;
  observedChanges?: readonly ObservedChange[];
}

export function fakeTaskRuntime(init: FakeTaskRuntimeInit = {}): FakeTaskRuntime {
  const events: TaskEvent[] = [];
  const changeEvents: ChangeRecordedEvent[] = [];
  const calls: string[] = [];
  const decisions: AttributionDecision[] = [];
  const files = new Map<string, string>(Object.entries(init.files ?? {}));
  let observed: ObservedChange[] = [...(init.observedChanges ?? [])];
  let version = 0;
  let openContexts = 0;
  let status: FakeTaskStatus = "running";
  const activeLeases = new Set<symbol>();

  const hashOf = (path: string): string | null => {
    const content = files.get(path);
    return content === undefined ? null : sha256Hex(content);
  };
  const requireActive = (context: TaskMutationContext, method: string): void => {
    if (!activeLeases.has(context.leaseToken)) {
      throw new Error(`fake task runtime: ${method} requires an active TaskMutationContext`);
    }
  };

  return {
    events,
    changeEvents,
    calls,
    decisions,
    get status() {
      return status;
    },
    set status(next: FakeTaskStatus) {
      status = next;
    },
    get openContexts() {
      return openContexts;
    },
    writeFile(path, content) {
      files.set(path, content);
    },
    setObservedChanges(changes) {
      observed = [...changes];
    },

    async acquireMutationContext(scope: TaskScope, _signal?: AbortSignal): Promise<TaskMutationContext> {
      calls.push("acquireMutationContext");
      const leaseToken = Symbol(`lease:${scope.taskId}:${scope.invocationId}`);
      activeLeases.add(leaseToken);
      openContexts += 1;
      return {
        taskId: scope.taskId,
        routeId: scope.routeId,
        workspaceKey: `workspace:${scope.taskId}`,
        leaseToken,
        [Symbol.asyncDispose]: async () => {
          if (!activeLeases.delete(leaseToken)) {
            throw new Error("fake task runtime: mutation context already disposed");
          }
          openContexts -= 1;
          calls.push("dispose");
        },
      };
    },

    async readExpectedVersion(context: TaskMutationContext): Promise<WorkspaceVersion> {
      requireActive(context, "readExpectedVersion");
      calls.push("readExpectedVersion");
      return `v${version}`;
    },

    async captureBefore(context: TaskMutationContext, input: CaptureBeforeInput): Promise<BeforeCapture> {
      requireActive(context, "captureBefore");
      calls.push("captureBefore");
      return {
        version: `v${version}`,
        paths: input.paths.map((path) => ({ path, hash: hashOf(path) })),
      };
    },

    async captureAfter(context: TaskMutationContext, input: CaptureAfterInput): Promise<AfterCapture> {
      requireActive(context, "captureAfter");
      calls.push("captureAfter");
      if (input.expectedVersion !== `v${version}`) {
        throw new Error(
          `fake task runtime: workspace version moved (${input.expectedVersion} → v${version}) before captureAfter`,
        );
      }
      const declared = input.paths.map((path) => ({ path, hash: hashOf(path) }));
      const unknown = observed;
      observed = [];
      return { version: `v${version}`, declared, unknown };
    },

    async append(context: TaskMutationContext, event: TaskEvent): Promise<void> {
      requireActive(context, "append");
      calls.push("append");
      events.push(event);
      if (event.type === "changeRecorded") {
        changeEvents.push(event);
      }
      if (event.type === "attributionPending" || event.type === "attributionConflict") {
        for (const path of event.paths) {
          decisions.push(
            event.type === "attributionPending"
              ? toAttributionPending({ path, source: "unknown", beforeHash: null, afterHash: hashOf(path) })
              : {
                  path,
                  status: "conflict" as const,
                  source: "unknown" as const,
                  beforeHash: null,
                  afterHash: hashOf(path),
                  protectedHash: null,
                },
          );
        }
        status = "paused";
      }
      if (event.type === "attributionResolved") {
        const index = decisions.findIndex((decision) => decision.path === event.path);
        if (index >= 0) {
          decisions[index] =
            event.attribution === "task-owned"
              ? resolveAsTaskOwned(decisions[index])
              : resolveAsExternal(decisions[index]);
        }
        status = hasUnresolvedAttribution(decisions)
          ? "paused"
          : event.status === "pending-review"
            ? "review"
            : "running";
      }
      version += 1;
    },

    async requireAttribution(context: TaskMutationContext): Promise<AttributionDecision[]> {
      requireActive(context, "requireAttribution");
      calls.push("requireAttribution");
      return decisions.map((decision) => ({ ...decision }));
    },
  };
}

/** A TaskScope for direct port/middleware calls (defaults: task-1 / route-1). */
export function testTaskScope(
  toolName = "Test",
  identity: { taskId?: string; routeId?: string; parentInvocationId?: string } = {},
): TaskScope {
  return {
    ...createExecutionScope(toolName, undefined, identity),
    taskId: identity.taskId ?? "task-1",
    routeId: identity.routeId ?? "route-1",
  };
}

/** Seeds pending attribution the way the middleware does: one append under a real context. */
export async function seedPendingAttribution(runtime: FakeTaskRuntime, paths: readonly string[]): Promise<void> {
  const context = await runtime.acquireMutationContext(testTaskScope("Seed"));
  await runtime.append(context, { type: "attributionPending", paths: [...paths] });
  await context[Symbol.asyncDispose]();
}

export interface FakeToolOptions {
  failWith?: Error;
  onExecute?: () => void;
}

/** Write-class process tool with a command resource (no declared path targets). */
export function fakeShellTool(options: FakeToolOptions = {}): Tool {
  return {
    name: "Shell",
    description: "test shell command tool",
    readOnly: false,
    sideEffect: "process",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    permissionResource: () => ({ action: "execute", kind: "command", scope: "sh" }),
    persistArgs: (args) => ({ command: String(args.command ?? "") }),
    async execute() {
      options.onExecute?.();
      if (options.failWith) throw options.failWith;
      return { content: "command ok" };
    },
  };
}

/** Path-write tool: declares its target through a write/path permission resource. */
export function fakeWriteTool(runtime: FakeTaskRuntime, options: FakeToolOptions = {}): Tool {
  return {
    name: "Write",
    description: "test file write tool (declared write target)",
    readOnly: false,
    sideEffect: "paths",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    permissionResource: (args) => ({ action: "write", kind: "path", scope: String(args.path ?? "") }),
    persistArgs: (args) => ({ path: String(args.path ?? "") }),
    async execute(args) {
      options.onExecute?.();
      if (options.failWith) throw options.failWith;
      runtime.writeFile(String(args.path ?? ""), String(args.content ?? ""));
      return { content: `wrote ${String(args.path ?? "")}` };
    },
  };
}

/** Read-only tool: the middleware must never capture around it. */
export function fakeReadTool(options: FakeToolOptions = {}): Tool {
  return {
    name: "Read",
    description: "test read-only tool",
    readOnly: true,
    sideEffect: "none",
    parameters: { type: "object" },
    permissionResource: () => ({ action: "read", kind: "path", scope: "." }),
    persistArgs: (args) => ({ ...args }),
    async execute() {
      options.onExecute?.();
      return { content: "read ok" };
    },
  };
}

export type ScriptedPart =
  | { type: "toolCall"; id: string; toolName: string; args: Record<string, unknown> }
  | { type: "text"; text: string };

/** Yields the scripted parts of successive model turns; the last step repeats. */
export function scriptedProvider(script: readonly (readonly ScriptedPart[])[]): Provider {
  let step = 0;
  return {
    id: "scripted",
    async *chat(): AsyncIterable<Delta> {
      const parts = script[Math.min(step, script.length - 1)] ?? [];
      step += 1;
      for (const part of parts) yield part;
    },
  };
}

export function toolLookup(tools: readonly Tool[]): (toolName: string) => Tool | undefined {
  return (toolName) => tools.find((tool) => tool.name === toolName);
}

export const TEST_WORKSPACE_ROOT = "D:/tmp/plugin-task-test";

/** Session with the given plugin + tools, auto permissions (middleware sees permission-passed calls). */
export async function createSessionWith(
  plugin: HarnessPlugin,
  tools: readonly Tool[],
  provider: Provider,
): Promise<AgentSession> {
  return AgentSession.create({
    plugins: [
      {
        name: "test-tools",
        activate(ctx) {
          for (const tool of tools) ctx.registerTool(tool);
        },
      },
      plugin,
    ],
    provider,
    workspaceRoot: TEST_WORKSPACE_ROOT,
    permission: { mode: "auto", decider: { ask: async () => "deny" } },
  });
}

/**
 * Runs a parent task whose delegated child session writes one file. The
 * delegate tool goes through the kernel spawner (bindSubagentSpawner-bound),
 * so the child session inherits the middleware and the parent task scope
 * with parentInvocationId stamped — the real delegation wiring.
 */
export async function runParentTaskWithChild(options: {
  task: FakeTaskRuntime;
  writePath?: string;
}): Promise<void> {
  const writePath = options.writePath ?? "src/a.ts";
  const writeTool = fakeWriteTool(options.task);
  const delegateTool: Tool = {
    name: "Delegate",
    description: "spawns a child agent session through the kernel spawner",
    readOnly: false,
    sideEffect: "delegated",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
    permissionResource: () => ({ action: "spawn", kind: "agent", scope: "child" }),
    persistArgs: (args) => ({ promptLength: String(args.prompt ?? "").length }),
    async execute(_args, ctx) {
      if (!ctx.subagent) {
        return { content: "no subagent spawner available", isError: true };
      }
      const result = await ctx.subagent.run({
        systemPrompt: "child agent",
        tools: "all",
        prompt: "write the file",
      });
      return { content: result.finalText };
    },
  };
  const tools = [delegateTool, writeTool];
  const session = await AgentSession.create({
    plugins: [
      {
        name: "test-tools",
        activate(ctx) {
          for (const tool of tools) ctx.registerTool(tool);
        },
      },
      taskPlugin({ port: options.task, lookupTool: toolLookup(tools), workspaceRoot: TEST_WORKSPACE_ROOT }),
    ],
    provider: dualChannelProvider(writePath),
    workspaceRoot: TEST_WORKSPACE_ROOT,
    permission: { mode: "auto", decider: { ask: async () => "deny" } },
  });
  await session.run("run the task", undefined, { taskId: "task-1" });
}

/** Parent channel drives the Delegate tool; the child channel writes the file. */
function dualChannelProvider(writePath: string): Provider {
  let parentTurn = 0;
  let childTurn = 0;
  return {
    id: "dual",
    async *chat(req) {
      if (req.system.includes("child agent")) {
        childTurn += 1;
        if (childTurn === 1) {
          yield { type: "toolCall", id: "c1", toolName: "Write", args: { path: writePath, content: "child content" } };
        } else {
          yield { type: "text", text: "子代理完成" };
        }
        return;
      }
      parentTurn += 1;
      if (parentTurn === 1) {
        yield { type: "toolCall", id: "p1", toolName: "Delegate", args: { prompt: "write it" } };
      } else {
        yield { type: "text", text: "父任务完成" };
      }
    },
  };
}
