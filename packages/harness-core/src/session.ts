import { ContextManager } from "./context-manager";
import type { HarnessEventListener } from "./events";
import { runLoop, DEFAULT_MAX_TURNS, DEFAULT_TOOL_TIMEOUT_MS } from "./loop";
import { PermissionEngine, type PermissionDecider } from "./permission";
import { rulesFromConfig, type ProjectPermissionConfig } from "./policy-config";
import type { PermissionMode } from "./policy";
import { PluginRegistry, type HarnessPlugin, type Logger } from "./registry";
import type { Provider } from "./provider";
import type { Message } from "./types";

export interface AgentSessionOptions {
  plugins: HarnessPlugin[];
  /** Provider instance, or the id of one registered by a plugin. */
  provider?: Provider;
  providerId?: string;
  workspaceRoot: string;
  systemPrompt?: string;
  permission: {
    mode: PermissionMode;
    decider: PermissionDecider;
    projectConfig?: ProjectPermissionConfig;
  };
  compaction?: Partial<{ maxContextTokens: number; keepRecent: number }>;
  maxTurns?: number;
  toolTimeoutMs?: number;
  logger?: Logger;
}

export interface RunSummary {
  turns: number;
  finalText: string;
  aborted: boolean;
}

const noopLogger: Logger = () => {};

/**
 * Ties the registry, provider, permission engine, compactor and event stream
 * into one conversational session. Hosts (Electron, CLI, tests) subscribe to
 * events and inject the permission decider.
 */
export class AgentSession {
  readonly registry: PluginRegistry;
  readonly permission: PermissionEngine;
  readonly provider: Provider;
  readonly workspaceRoot: string;
  readonly history: Message[] = [];
  readonly options: AgentSessionOptions;

  private baseSystemPrompt: string;
  private compactor: ContextManager;
  private listeners = new Set<HarnessEventListener>();
  private abort: AbortController | undefined;
  private logger: Logger;

  private constructor(
    options: AgentSessionOptions,
    registry: PluginRegistry,
    provider: Provider,
  ) {
    this.options = options;
    this.registry = registry;
    this.provider = provider;
    this.workspaceRoot = options.workspaceRoot;
    this.baseSystemPrompt = options.systemPrompt ?? "";
    this.logger = options.logger ?? noopLogger;
    this.permission = new PermissionEngine({
      mode: options.permission.mode,
      decider: options.permission.decider,
      workspaceRoot: options.workspaceRoot,
    });
    this.compactor = new ContextManager(options.compaction ?? {});
  }

  static async create(options: AgentSessionOptions): Promise<AgentSession> {
    const registry = new PluginRegistry();
    const logger = options.logger ?? noopLogger;
    await registry.load(options.plugins, logger);
    const provider =
      options.provider ?? registry.providers.get(options.providerId ?? "");
    if (!provider) {
      throw new Error(
        options.providerId
          ? `provider not found: ${options.providerId}`
          : "no provider configured",
      );
    }
    const session = new AgentSession(options, registry, provider);
    session.permission.addRules(registry.policyRules);
    if (options.permission.projectConfig) {
      session.permission.addRules(rulesFromConfig(options.permission.projectConfig));
    }
    return session;
  }

  on(listener: HarnessEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSystemPrompt(prompt: string): void {
    this.baseSystemPrompt = prompt;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permission.setMode(mode);
  }

  /** Skills index table appended to the system prompt (descriptions only). */
  private buildSystemPrompt(): string {
    const skills = [...this.registry.skills.values()];
    if (skills.length === 0) return this.baseSystemPrompt;
    const index = skills
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n");
    return `${this.baseSystemPrompt}\n\n可用技能（用户以 /名称 调用；相关时你也可以建议）：\n${index}`;
  }

  /** Expands "/skillname ..." input by loading the skill body as context. */
  private async expandUserText(text: string): Promise<string> {
    const match = /^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/.exec(text.trim());
    if (!match) return text;
    const skill = this.registry.skills.get(match[1]);
    if (!skill) return text;
    const body = await skill.loadBody();
    return `[已加载技能 ${skill.name}]\n${body}\n\n[用户输入]\n${match[2]}`;
  }

  async run(userText: string, signal?: AbortSignal): Promise<RunSummary> {
    const expanded = await this.expandUserText(userText);
    this.abort = new AbortController();
    if (signal) {
      if (signal.aborted) this.abort.abort();
      else signal.addEventListener("abort", () => this.abort!.abort(), { once: true });
    }
    const result = await runLoop(this.history, expanded, {
      provider: this.provider,
      registry: this.registry,
      permission: this.permission,
      systemPrompt: this.buildSystemPrompt(),
      workspaceRoot: this.workspaceRoot,
      onEvent: (e) => {
        for (const l of this.listeners) l(e);
        if (e.type === "error") this.logger("error", e.message);
      },
      compactor: this.compactor,
      signal: this.abort.signal,
      maxTurns: this.options.maxTurns ?? DEFAULT_MAX_TURNS,
      toolTimeoutMs: this.options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    });
    this.abort = undefined;
    return result;
  }

  stop(): void {
    this.abort?.abort();
  }
}
