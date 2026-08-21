// Session registry compat view: the PluginRegistry read surface (live
// maps/lists, toolSpecs, createContext) backed by the spine services. All
// registrations flow through the chokepoint methods below so the service
// gates (duplicate checks, persistence SPI) stay authoritative while the
// map-shaped views mirror them for host consumers (runtime.ts adopts
// `session.registry.tools`; probes register through createContext).
import type { PermissionsService } from "@innocencecode/harness-permissions";
import type { ProvidersService } from "@innocencecode/harness-providers";
import type { SessionService } from "@innocencecode/harness-session";
import type { MessageProcessor } from "@innocencecode/harness-session";
import type { SkillsService } from "@innocencecode/harness-skills";
import type { Tool, ToolExecutionMiddleware, ToolsService } from "@innocencecode/harness-tools";
import type { PolicyRule } from "@innocencecode/harness-permissions";
import type { Provider, ToolSpec } from "@innocencecode/harness-providers";
import type { Logger, PluginContext } from "./registry";
import type { Skill } from "@innocencecode/harness-skills";

/**
 * Read-only compat view over the spine services. Tools/providers/skills are
 * mirrored at the registration chokepoints (the spine services expose no
 * full-map iteration); policy rules, tool middlewares and processors expose
 * the services' live arrays (never snapshots). Processors registered before
 * the session service mounts are held here in order and flushed 1:1 when it
 * does — the provider needed to construct that service is only resolvable
 * after the host plugins have registered theirs.
 */
export class SessionRegistryView {
  private readonly registeredTools = new Map<string, Tool>();
  private readonly registeredToolOrder: Tool[] = [];
  private readonly registeredProviders = new Map<string, Provider>();
  private readonly registeredSkills = new Map<string, Skill>();
  private readonly registeredProcessors: MessageProcessor[] = [];
  private sessionService: SessionService | undefined;

  constructor(
    private readonly toolsService: ToolsService,
    private readonly providersService: ProvidersService,
    private readonly skillsService: SkillsService,
    private readonly permissionsService: PermissionsService,
  ) {}

  get tools(): ReadonlyMap<string, Tool> {
    return this.registeredTools;
  }

  get providers(): ReadonlyMap<string, Provider> {
    return this.registeredProviders;
  }

  get skills(): ReadonlyMap<string, Skill> {
    return this.registeredSkills;
  }

  /** Registered rules in registration order (the permissions service's live array). */
  get policyRules(): readonly PolicyRule[] {
    return this.permissionsService.policyRules();
  }

  /** Execution middleware in registration order, later = inner layer (live array). */
  get toolMiddlewares(): readonly ToolExecutionMiddleware[] {
    return this.toolsService.middlewares();
  }

  /** Registered processors in registration order (this view's live array). */
  get messageProcessors(): readonly MessageProcessor[] {
    return this.registeredProcessors;
  }

  /** Live registration-order tool list; the spawner's selection base. */
  get toolsInRegistrationOrder(): readonly Tool[] {
    return this.registeredToolOrder;
  }

  /** Provider-facing descriptions of every registered tool. */
  toolSpecs(): ToolSpec[] {
    return this.toolsService.specs();
  }

  /** Binds the late-mounted session service and flushes queued processors in order. */
  bindSessionService(service: SessionService): void {
    this.sessionService = service;
    for (const processor of this.registeredProcessors) {
      service.registerProcessor(processor);
    }
  }

  /** Single registration chokepoints: the service gate first, the mirror on success. */
  registerTool = (tool: Tool): void => {
    this.toolsService.register(tool);
    this.registeredTools.set(tool.name, tool);
    this.registeredToolOrder.push(tool);
  };

  registerProvider = (provider: Provider): void => {
    this.providersService.register(provider);
    this.registeredProviders.set(provider.id, provider);
  };

  registerSkill = (skill: Skill): void => {
    this.skillsService.register(skill);
    this.registeredSkills.set(skill.name, skill);
  };

  registerPolicyRule = (rule: PolicyRule): void => {
    this.permissionsService.registerPolicyRule(rule);
  };

  registerMessageProcessor = (processor: MessageProcessor): void => {
    this.registeredProcessors.push(processor);
    this.sessionService?.registerProcessor(processor);
  };

  registerToolMiddleware = (middleware: ToolExecutionMiddleware): void => {
    this.toolsService.registerMiddleware(middleware);
  };

  /** A PluginContext shaped exactly like the legacy registry's. */
  createContext(pluginName: string, log: Logger): PluginContext {
    return {
      registerTool: this.registerTool,
      registerProvider: this.registerProvider,
      registerSkill: this.registerSkill,
      registerPolicyRule: this.registerPolicyRule,
      registerMessageProcessor: this.registerMessageProcessor,
      registerToolMiddleware: this.registerToolMiddleware,
      log: (level, msg, data) => log(level, `[${pluginName}] ${msg}`, data),
    };
  }
}
