import type { PermissionEngine } from "@innocencecode/harness-permissions";
import type { Provider } from "@innocencecode/harness-providers";
import type { MessageProcessor } from "@innocencecode/harness-session";
import type {
  ExecutionScope,
  ExecutionScopeIdentity,
  Tool,
  ToolExecutionMiddleware,
} from "@innocencecode/harness-tools";
import type { Context } from "@innocencecode/kernel";
import type { SubagentResult } from "./subagent";

// Services are typed on `Context` through declaration merging by their
// publisher (kernel ServiceTable contract). The member is live only while the
// spawner plugin fiber publishing it is active; before load and after its
// unwind the property is absent at runtime.
declare module "@innocencecode/kernel" {
  interface Context {
    spawner: SpawnerService;
  }
}

/** Concurrent-child cap of the original AgentSession spawner (session.ts:23). */
export const SUBAGENT_CONCURRENCY = 3;

/** Error logger shape shared with the harness Logger (level, message, data). */
export type SpawnerLogger = (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;

/** One spawn request against the spawner service. */
export interface SpawnerSessionInput {
  /** System prompt for the child session (the agent-type prompt). */
  systemPrompt: string;
  prompt: string;
  /** Tool names the child may use; "readOnly" = every readOnly tool; "all" = everything (Task itself is always excluded). */
  tools: string[] | "readOnly" | "all";
  /** Parent state the child re-registers: processors and tool middlewares as-is, in order. */
  inherit: { processors: MessageProcessor[]; middlewares: ToolExecutionMiddleware[] };
  /** Maximum loop turns for the child (default 20). */
  maxTurns?: number;
  signal?: AbortSignal;
  /**
   * Loop-bound identity of the invocation spawning this child
   * (`bindSubagentSpawner` supplies it). The child run inherits
   * sessionId/taskId/routeId from it and stamps `parentInvocationId` with its
   * invocation id. Hosts calling the service directly may omit it.
   */
  parentScope?: ExecutionScope;
}

/** {@link SpawnerSessionInput} plus the spawning session fallback identity. */
export interface SpawnerRunInput extends SpawnerSessionInput {
  /** Session id used when no parent scope supplies one. */
  sessionId?: string;
}

/** Child-session materials the spawner assembles per spawn (session.ts:317-356). */
export interface SpawnerChildMaterials {
  /** subagent-tools set: the tools selected from the parent set, "Task" excluded, parent order. */
  tools: readonly Tool[];
  /** subagent-inherit set: the parent's message processors, registration order. */
  processors: readonly MessageProcessor[];
  /** subagent-inherit set: the parent's tool middlewares, registration order. */
  middlewares: readonly ToolExecutionMiddleware[];
  /** Provider shared with the spawning session (never a copy). */
  provider: Provider;
  /** Permission engine shared with the spawning session: same rules, grants and mode. */
  permission: PermissionEngine;
  systemPrompt: string;
  /** Child turn cap; `maxTurns ?? 20` already applied. */
  maxTurns: number;
  /** Error logger shared with the parent session (dispose failures land here). */
  logger: SpawnerLogger;
}

/** Child session handle the spawner drives and disposes. */
export interface SpawnerChildSession {
  /** Runs the child prompt under the derived parent identity. */
  run(
    prompt: string,
    signal: AbortSignal | undefined,
    identity: ExecutionScopeIdentity,
  ): Promise<SubagentResult>;
  /** Releases the child session; failures are swallowed and logged by the spawner. */
  dispose(): Promise<void>;
}

/** Host adapter constructing the child session from the spawn materials. */
export type SpawnerSessionFactory = (materials: SpawnerChildMaterials) => Promise<SpawnerChildSession>;

/**
 * Spawner service: spawns a nested agent session sharing the parent's
 * provider and permission engine with its own isolated message history. The
 * child registers the SAME message processors and tool middlewares as the
 * spawning session, runs under the parent-derived identity, is
 * concurrency-capped, and is disposed in a finally once its run settles
 * (AgentSession.spawner semantics, session.ts:310-370).
 */
export interface SpawnerService {
  run(input: SpawnerRunInput): Promise<SubagentResult>;
}

/** Constructor dependencies of the spawner plugin (per-session state). */
export interface SpawnerDeps {
  /** Host adapter building the child session (T6 adapts AgentSession here). */
  sessionFactory: SpawnerSessionFactory;
  /** Provider shared with every child session. */
  provider: Provider;
  /** Permission engine shared with every child session. */
  permission: PermissionEngine;
  /** Parent tools in registration order; tool selection runs against this set. */
  tools: readonly Tool[];
  /** Concurrent-child cap; default {@link SUBAGENT_CONCURRENCY}. */
  concurrency?: number;
  /** Error sink for swallowed child dispose failures. */
  logger?: SpawnerLogger;
}

/** Shape of the spawner spine plugin (kernel Plugin contract). */
export interface SpawnerPlugin {
  readonly name: "harness-spawner";
  apply(ctx: Context): () => void;
}

/**
 * Creates the spawner spine plugin for one session (the concurrency slots and
 * shared provider/engine are session state, so the plugin is created per
 * session — the permissions factory precedent). `apply` publishes the service
 * under "spawner" and returns the withdraw handle, so the service disappears
 * when the plugin fiber unwinds.
 */
export function createSpawnerPlugin(deps: SpawnerDeps): SpawnerPlugin {
  const concurrency = deps.concurrency ?? SUBAGENT_CONCURRENCY;
  const logger: SpawnerLogger = deps.logger ?? (() => {});
  let activeChildren = 0;

  const service: SpawnerService = {
    run: async (input): Promise<SubagentResult> => {
      if (activeChildren >= concurrency) {
        throw new Error(`子代理并发已达上限（${concurrency}），请稍后再派生`);
      }
      activeChildren += 1;
      try {
        const allTools = deps.tools.filter((t) => t.name !== "Task");
        const selected =
          input.tools === "all"
            ? allTools
            : input.tools === "readOnly"
              ? allTools.filter((t) => t.readOnly)
              : allTools.filter((t) => input.tools.includes(t.name));
        // Same registration set as the parent: identical processor and
        // middleware objects, in the parent's registration order.
        const child = await deps.sessionFactory({
          tools: selected,
          processors: input.inherit.processors,
          middlewares: input.inherit.middlewares,
          provider: deps.provider,
          permission: deps.permission, // shared rules, grants and mode
          systemPrompt: input.systemPrompt,
          maxTurns: input.maxTurns ?? 20,
          logger,
        });
        try {
          const parent = input.parentScope;
          const result = await child.run(input.prompt, input.signal, {
            sessionId: parent?.sessionId ?? input.sessionId,
            taskId: parent?.taskId,
            routeId: parent?.routeId,
            parentInvocationId: parent?.invocationId,
          });
          return { finalText: result.finalText, turns: result.turns };
        } finally {
          // A dispose failure must never mask the child run's own outcome —
          // log and swallow it (create's rollback path does the same).
          await child.dispose().catch((disposeError) => {
            logger("error", "subagent child dispose failed", disposeError);
          });
        }
      } finally {
        activeChildren -= 1;
      }
    },
  };

  return {
    name: "harness-spawner",
    apply: (ctx) => ctx.provide("spawner", service),
  };
}
