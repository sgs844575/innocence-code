// Session spawner wiring: adapts the spine SpawnerService into the public
// AgentSession.spawner face, and builds the child sessions it spawns — the
// recursive AgentSession.create adapter (shared provider/engine, inherited
// processors/middlewares in order, parent workspaceRoot closure).
import type { SpawnerChildMaterials, SpawnerChildSession, SubagentSpawner } from "@innocencecode/harness-agent";
import type { SpawnerService } from "@innocencecode/harness-agent";
import type { MessageProcessor } from "@innocencecode/harness-session";
import type { ToolExecutionMiddleware } from "@innocencecode/harness-tools";
import { AgentSession } from "./session";
import type { AgentSessionOptions } from "./session";
import type { SessionRegistryView } from "./session-registry-view";

/**
 * The public spawner member: delegates to the spine SpawnerService, always
 * passing the session's own id as the fallback identity (direct, unbound
 * spawn calls) and the LIVE processor/middleware arrays so the child
 * re-registers exactly what the parent registered, in order.
 */
export function makeSessionSpawner(
  spawnerService: SpawnerService,
  sessionId: string,
  view: SessionRegistryView,
): SubagentSpawner {
  return {
    run: (options) =>
      spawnerService.run({
        ...options,
        sessionId,
        // Live arrays (never snapshots); the mutable-array cast satisfies the
        // service input shape — the service only reads them.
        inherit: {
          processors: view.messageProcessors as MessageProcessor[],
          middlewares: view.toolMiddlewares as ToolExecutionMiddleware[],
        },
      }),
  };
}

/**
 * Spawner child-session factory: the recursive AgentSession adapter. The
 * materials come from the spawner service; workspaceRoot, the permission
 * decider and the spine suite close over the PARENT session's options (the
 * material face does not carry them).
 */
export function createSpawnerChildSession(
  parentOptions: AgentSessionOptions,
  materials: SpawnerChildMaterials,
): Promise<SpawnerChildSession> {
  return AgentSession.create({
    plugins: [
      {
        name: "subagent-tools",
        activate: (ctx) => {
          for (const tool of materials.tools) ctx.registerTool(tool);
        },
      },
      {
        // Same registration set as the parent: identical processor and
        // middleware objects, in the parent's registration order.
        name: "subagent-inherit",
        activate: (ctx) => {
          for (const processor of materials.processors) ctx.registerMessageProcessor(processor);
          for (const middleware of materials.middlewares) ctx.registerToolMiddleware(middleware);
        },
      },
    ],
    provider: materials.provider,
    workspaceRoot: parentOptions.workspaceRoot,
    systemPrompt: materials.systemPrompt,
    // spine is process-level injected identity: the child mounts the parent's
    // suite so every session in the process shares one set of spine module
    // identities (scope stays session-level and is NOT inherited — the child
    // is its own session instance on a fresh root).
    spine: parentOptions.spine,
    permission: {
      mode: materials.permission.getMode(),
      decider: parentOptions.permission.decider,
      engine: materials.permission, // shared rules, grants and mode
    },
    maxTurns: materials.maxTurns,
    logger: materials.logger,
  }).then((child) => ({
    run: (prompt, signal, identity) => child.run(prompt, signal, identity),
    dispose: () => child.dispose(),
  }));
}
