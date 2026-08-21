// Session kernel composition: mounts the spine service plugins on one kernel
// Context, loads the host plugins through the HarnessPluginAdapter, resolves
// the provider, mounts the session-owned services (ledger/processors and the
// spawner), asserts the spine skeleton, and rolls the whole context back on
// any failure (a failed create never leaks an activated plugin).
import { Context, type Fiber } from "@innocencecode/kernel";
import { LoggerPlugin } from "@innocencecode/kernel-logger";
import {
  AgentsPlugin,
  createSpawnerPlugin,
  type AgentsService,
  type SpawnerService,
  type SpawnerSessionFactory,
} from "@innocencecode/harness-agent";
import {
  createPermissionsPlugin,
  createPermissionsService,
  rulesFromConfig,
  type PermissionsService,
} from "@innocencecode/harness-permissions";
import { ProvidersPlugin, type Provider, type ProvidersService } from "@innocencecode/harness-providers";
import { createSessionPlugin, type SessionService } from "@innocencecode/harness-session";
import { SkillsPlugin, type SkillsService } from "@innocencecode/harness-skills";
import { SystemPromptPlugin, type SystemPromptService } from "@innocencecode/harness-system-prompt";
import { ToolsPlugin, type ToolsService } from "@innocencecode/harness-tools";
import type { AgentSessionOptions } from "./session";
import type { HarnessPlugin, Logger } from "./registry";
import { adaptHarnessPlugin } from "./session-adapter";
import { SessionRegistryView } from "./session-registry-view";

// kernel-logger publishes its service without a Context augmentation; the
// session composition declares the typed member (kernel ServiceTable
// contract, same pattern the spine packages use for their services).
declare module "@innocencecode/kernel" {
  interface Context {
    logger: import("@innocencecode/kernel-logger").LoggerService;
  }
}

/** Spine services the kernelized session runs on. */
export interface SessionKernelServices {
  tools: ToolsService;
  permissions: PermissionsService;
  providers: ProvidersService;
  skills: SkillsService;
  systemPrompt: SystemPromptService;
  agents: AgentsService;
  session: SessionService;
  spawner: SpawnerService;
}

/** One mounted session kernel: the context, its services and the compat view. */
export interface SessionKernel {
  readonly ctx: Context;
  readonly provider: Provider;
  readonly services: SessionKernelServices;
  readonly view: SessionRegistryView;
  /** Adapter fibers in activation order; dispose-error collection reads these. */
  readonly pluginFibers: readonly Fiber[];
}

/** Inputs of {@link mountSessionKernel} (everything AgentSession.create owns). */
export interface SessionKernelInit {
  sessionId: string;
  plugins: HarnessPlugin[];
  provider?: Provider;
  providerId?: string;
  workspaceRoot: string;
  systemPrompt?: string;
  permission: AgentSessionOptions["permission"];
  compaction?: AgentSessionOptions["compaction"];
  logger: Logger;
  /** Recursion seam: the spawner's child-session factory (back into AgentSession). */
  spawnerSessionFactory: SpawnerSessionFactory;
}

/** Asserts every named spine service is resolvable on the context (骨架就绪). */
function assertServices(ctx: Context, names: readonly string[]): void {
  for (const name of names) {
    if (ctx.services.resolve(name) === undefined) {
      throw new Error(`spine service missing after mount: ${name}`);
    }
  }
}

/**
 * Mount order (behavior-preserving; see the task report for the one order
 * deviation forced by providerId resolution):
 *  1. kernel-logger (plugin log prefixing), tools, permissions, providers,
 *     skills, system-prompt, agents — the registration skeleton, asserted
 *     before any host plugin loads;
 *  2. host plugins through the HarnessPluginAdapter, sequentially (a failed
 *     activation rolls the whole context back and rethrows);
 *  3. provider resolution (`options.provider` ?? provider registered by a
 *     plugin), then the session service (ledger + processors + compactor —
 *     queued processors flush here) and the spawner;
 *  4. full skeleton assertion, then the project permission config rules land
 *     on a session-built engine only (an injected engine carries its own).
 */
export async function mountSessionKernel(init: SessionKernelInit): Promise<SessionKernel> {
  const ctx = new Context();
  const log = init.logger;
  // Declared outside the try so the rollback can read what had loaded so far.
  const pluginFibers: Fiber[] = [];
  try {
    await ctx.plugin(LoggerPlugin);
    ctx.logger.addSink(
      (entry) => {
        if (entry.level !== "debug") log(entry.level, entry.message, entry.data);
      },
      { minLevel: "info" },
    );

    await ctx.plugin(ToolsPlugin);
    const permissions = init.permission.engine
      ? createPermissionsService(init.permission.engine)
      : createPermissionsService({
          mode: init.permission.mode,
          decider: init.permission.decider,
          workspaceRoot: init.workspaceRoot,
          validateResource: init.permission.validateResource,
          audit: init.permission.audit,
        });
    await ctx.plugin(createPermissionsPlugin(permissions));
    await ctx.plugin(ProvidersPlugin);
    await ctx.plugin(SkillsPlugin);
    await ctx.plugin(SystemPromptPlugin);
    await ctx.plugin(AgentsPlugin);
    assertServices(ctx, [
      "logger",
      "tools",
      "permissions",
      "providers",
      "skills",
      "systemPrompt",
      "agents",
    ]);

    const view = new SessionRegistryView(ctx.tools, ctx.providers, ctx.skills, permissions);
    for (const plugin of init.plugins) {
      const fiber = ctx.plugin(adaptHarnessPlugin(plugin, view));
      pluginFibers.push(fiber);
      await fiber;
    }

    const provider = init.provider ?? ctx.providers.get(init.providerId ?? "");
    if (!provider) {
      throw new Error(
        init.providerId ? `provider not found: ${init.providerId}` : "no provider configured",
      );
    }

    await ctx.plugin(
      createSessionPlugin({
        provider,
        sessionId: init.sessionId,
        compaction: init.compaction,
      }),
    );
    view.bindSessionService(ctx.session);
    await ctx.plugin(
      createSpawnerPlugin({
        sessionFactory: init.spawnerSessionFactory,
        provider,
        permission: permissions.engine,
        tools: view.toolsInRegistrationOrder,
        logger: init.logger,
      }),
    );
    assertServices(ctx, [
      "tools",
      "permissions",
      "providers",
      "skills",
      "session",
      "systemPrompt",
      "spawner",
    ]);

    if (!init.permission.engine && init.permission.projectConfig) {
      permissions.engine.addRules(rulesFromConfig(init.permission.projectConfig));
    }
    ctx.systemPrompt.setBase(init.systemPrompt ?? "");

    return {
      ctx,
      provider,
      services: {
        tools: ctx.tools,
        permissions,
        providers: ctx.providers,
        skills: ctx.skills,
        systemPrompt: ctx.systemPrompt,
        agents: ctx.agents,
        session: ctx.session,
        spawner: ctx.spawner,
      },
      view,
      pluginFibers,
    };
  } catch (error) {
    // Construction failed after plugins activated: release their resources
    // before surfacing the error, so the failure path never leaks them.
    try {
      await ctx.fiber.dispose();
      for (const fiber of pluginFibers) {
        for (const unwindError of fiber.unwindErrors) {
          log("error", "dispose failed during activation rollback", unwindError);
        }
      }
    } catch (disposeError) {
      log("error", "kernel dispose failed during session create rollback", disposeError);
    }
    throw error;
  }
}
