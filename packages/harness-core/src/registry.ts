import type { PolicyRule } from "./policy";
import type { MessageProcessor } from "./processor";
import type { Provider, ToolSpec } from "./provider";
import type { Skill } from "./skill";
import type { Tool } from "./tool";

export type LogLevel = "info" | "warn" | "error";
export type Logger = (level: LogLevel, msg: string, data?: unknown) => void;

/** The only surface a plugin gets — registration plus logging. */
export interface PluginContext {
  registerTool(tool: Tool): void;
  registerProvider(provider: Provider): void;
  registerSkill(skill: Skill): void;
  registerPolicyRule(rule: PolicyRule): void;
  registerMessageProcessor(processor: MessageProcessor): void;
  log(level: LogLevel, msg: string, data?: unknown): void;
}

export interface HarnessPlugin {
  name: string;
  activate(ctx: PluginContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export class PluginRegistry {
  readonly tools = new Map<string, Tool>();
  readonly providers = new Map<string, Provider>();
  readonly skills = new Map<string, Skill>();
  readonly policyRules: PolicyRule[] = [];
  private readonly registeredMessageProcessors: MessageProcessor[] = [];
  /** Successfully activated plugins, awaiting reverse-order disposal. */
  private readonly activated: HarnessPlugin[] = [];

  get messageProcessors(): readonly MessageProcessor[] {
    return this.registeredMessageProcessors;
  }

  async load(plugins: HarnessPlugin[], log: Logger = () => {}): Promise<void> {
    for (const plugin of plugins) {
      try {
        await plugin.activate(this.createContext(plugin.name, log));
      } catch (error) {
        await this.disposeActivated((failed, disposeError) => {
          log("error", `dispose failed during activation rollback: ${failed.name}`, disposeError);
        });
        throw error;
      }
      this.activated.push(plugin);
    }
  }

  /** Idempotent: pops the activated stack once, so repeated calls are no-ops. */
  async dispose(): Promise<void> {
    const errors: unknown[] = [];
    await this.disposeActivated((_plugin, error) => errors.push(error));
    if (errors.length > 0) {
      const detail = errors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join("; ");
      throw new AggregateError(errors, `plugin dispose failed: ${detail}`);
    }
  }

  private async disposeActivated(
    onError: (plugin: HarnessPlugin, error: unknown) => void,
  ): Promise<void> {
    while (this.activated.length > 0) {
      const plugin = this.activated.pop()!;
      try {
        await plugin.dispose?.();
      } catch (error) {
        onError(plugin, error);
      }
    }
  }

  createContext(pluginName: string, log: Logger): PluginContext {
    return {
      registerTool: (tool) => {
        if (this.tools.has(tool.name)) {
          throw new Error(`duplicate tool registration: ${tool.name}`);
        }
        this.tools.set(tool.name, tool);
      },
      registerProvider: (provider) => {
        if (this.providers.has(provider.id)) {
          throw new Error(`duplicate provider registration: ${provider.id}`);
        }
        this.providers.set(provider.id, provider);
      },
      registerSkill: (skill) => {
        if (this.skills.has(skill.name)) {
          throw new Error(`duplicate skill registration: ${skill.name}`);
        }
        this.skills.set(skill.name, skill);
      },
      registerPolicyRule: (rule) => {
        this.policyRules.push(rule);
      },
      registerMessageProcessor: (processor) => {
        this.registeredMessageProcessors.push(processor);
      },
      log: (level, msg, data) => log(level, `[${pluginName}] ${msg}`, data),
    };
  }

  toolSpecs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      readOnly: t.readOnly,
      parameters: t.parameters,
    }));
  }
}
