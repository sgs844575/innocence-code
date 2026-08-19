import type { PolicyRule } from "./policy";
import type { MessageProcessor } from "./processor";
import type { Provider, ToolSpec } from "./provider";
import type { Skill } from "./skill";
import type { Tool } from "./tool";
import type { ToolExecutionMiddleware } from "./tool-execution";

export type LogLevel = "info" | "warn" | "error";
export type Logger = (level: LogLevel, msg: string, data?: unknown) => void;

/** Error code for the fail-closed tool persistence SPI gate. */
export const TOOL_PERSISTENCY_POLICY_REQUIRED = "tool-persistence-policy-required";

/**
 * Thrown when a Tool lacks persistArgs/permissionResource. There is no
 * legacy fallback: raw-argument persistence is never silently restored.
 */
export class ToolPersistenceError extends Error {
  readonly code = TOOL_PERSISTENCY_POLICY_REQUIRED;

  constructor(toolName: string, member: "permissionResource" | "persistArgs") {
    super(
      `tool ${toolName} must implement ${member} (${TOOL_PERSISTENCY_POLICY_REQUIRED}): ` +
        "every Tool has to declare a persistence-safe permission resource and persisted args copy",
    );
    this.name = "ToolPersistenceError";
  }
}

/** The only surface a plugin gets — registration plus logging. */
export interface PluginContext {
  registerTool(tool: Tool): void;
  registerProvider(provider: Provider): void;
  registerSkill(skill: Skill): void;
  registerPolicyRule(rule: PolicyRule): void;
  registerMessageProcessor(processor: MessageProcessor): void;
  /**
   * Registers execution-time middleware around every tool invocation.
   * Registration order is preserved; later registrations wrap closer to the
   * tool (inner layers), earlier ones run first.
   */
  registerToolMiddleware(middleware: ToolExecutionMiddleware): void;
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
  /** Execution middleware in registration order (later = inner layer). */
  readonly toolMiddlewares: ToolExecutionMiddleware[] = [];
  private readonly registeredMessageProcessors: MessageProcessor[] = [];
  /** Successfully activated plugins, awaiting reverse-order disposal. */
  private readonly activated: HarnessPlugin[] = [];
  /** Shared in-flight disposal: concurrent dispose() calls join one pass. */
  private disposeInFlight: Promise<void> | undefined;

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

  /**
   * Idempotent: pops the activated stack once, so repeated calls are no-ops.
   * Concurrent calls share the same in-flight pass (each plugin disposed
   * exactly once, strict reverse order, same outcome — including failures).
   */
  async dispose(): Promise<void> {
    if (!this.disposeInFlight) {
      const disposal = this.disposeOnce();
      // Cleared when settled so the field never pins a finished promise;
      // later calls run a fresh (empty-stack) pass instead of replaying it.
      this.disposeInFlight = disposal.finally(() => {
        this.disposeInFlight = undefined;
      });
    }
    return this.disposeInFlight;
  }

  private async disposeOnce(): Promise<void> {
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
        // Fail-closed persistence SPI: raw args must never be persistable by
        // default. Tool error messages must not contain raw args either — they
        // enter history/audit unredacted (see Tool.execute).
        if (typeof tool.permissionResource !== "function") {
          throw new ToolPersistenceError(tool.name, "permissionResource");
        }
        if (typeof tool.persistArgs !== "function") {
          throw new ToolPersistenceError(tool.name, "persistArgs");
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
      registerToolMiddleware: (middleware) => {
        this.toolMiddlewares.push(middleware);
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
