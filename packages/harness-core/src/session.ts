import { ContextManager } from "./context-manager";
import type { HarnessEventListener } from "./events";
import { runLoop, DEFAULT_MAX_TURNS, DEFAULT_TOOL_TIMEOUT_MS } from "./loop";
import {
  PermissionEngine,
  type PermissionAuditor,
  type PermissionDecider,
  type ResourceValidator,
} from "./permission";
import { rulesFromConfig, type ProjectPermissionConfig } from "./policy-config";
import type { PermissionMode } from "./policy";
import { PluginRegistry, type HarnessPlugin, type Logger } from "./registry";
import type { Provider } from "./provider";
import type { Message } from "./types";
import type { SubagentOptions, SubagentResult, SubagentSpawner } from "./subagent";

const SUBAGENT_CONCURRENCY = 3;

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
    /** Inject an existing engine (e.g. parent session's) to share rules+grants. */
    engine?: PermissionEngine;
    /**
     * Hard resource validation for the session-built engine — runs in every
     * mode (full only skips asking). Ignored when `engine` is injected (the
     * injected engine carries its own validator).
     */
    validateResource?: ResourceValidator;
    /**
     * Audit sink for the session-built engine; one entry per resolution with
     * the persisted request. Ignored when `engine` is injected.
     */
    audit?: PermissionAuditor;
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
  private activeRun: Promise<unknown> | undefined;
  private logger: Logger;
  private activeSubagents = 0;

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
    this.permission =
      options.permission.engine ??
      new PermissionEngine({
        mode: options.permission.mode,
        decider: options.permission.decider,
        workspaceRoot: options.workspaceRoot,
        validateResource: options.permission.validateResource,
        audit: options.permission.audit,
      });
    this.compactor = new ContextManager(options.compaction ?? {});
  }

  static async create(options: AgentSessionOptions): Promise<AgentSession> {
    const registry = new PluginRegistry();
    const logger = options.logger ?? noopLogger;
    await registry.load(options.plugins, logger);
    try {
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
      if (!options.permission.engine) {
        session.permission.addRules(registry.policyRules);
        if (options.permission.projectConfig) {
          session.permission.addRules(rulesFromConfig(options.permission.projectConfig));
        }
      }
      return session;
    } catch (error) {
      // Construction failed after plugins activated: release their resources
      // before surfacing the error, so the failure path never leaks them.
      try {
        await registry.dispose();
      } catch (disposeError) {
        logger("error", "registry dispose failed during session create rollback", disposeError);
      }
      throw error;
    }
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
    const running = runLoop(this.history, expanded, {
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
      spawner: this.spawner,
    });
    this.activeRun = running;
    try {
      return await running;
    } finally {
      this.activeRun = undefined;
      this.abort = undefined;
    }
  }

  stop(): void {
    this.abort?.abort();
  }

  /** Aborts the active run, waits for it to settle, then disposes all plugins. */
  async dispose(): Promise<void> {
    this.abort?.abort();
    if (this.activeRun) {
      await this.activeRun.catch(() => {});
    }
    await this.registry.dispose();
  }

  /**
   * Spawns a nested agent session sharing this session's provider, permission
   * engine (so child tool calls hit the same approval flow) and workspace,
   * with its own isolated message history. Concurrency-capped.
   */
  readonly spawner: SubagentSpawner = {
    run: async (options: SubagentOptions): Promise<SubagentResult> => {
      if (this.activeSubagents >= SUBAGENT_CONCURRENCY) {
        throw new Error(`子代理并发已达上限（${SUBAGENT_CONCURRENCY}），请稍后再派生`);
      }
      this.activeSubagents += 1;
      try {
        const allTools = [...this.registry.tools.values()].filter((t) => t.name !== "Task");
        const selected =
          options.tools === "all"
            ? allTools
            : options.tools === "readOnly"
              ? allTools.filter((t) => t.readOnly)
              : allTools.filter((t) => options.tools.includes(t.name));
        const toolsPlugin: HarnessPlugin = {
          name: "subagent-tools",
          activate: (ctx) => {
            for (const tool of selected) ctx.registerTool(tool);
          },
        };
        const child = await AgentSession.create({
          plugins: [toolsPlugin],
          provider: this.provider,
          workspaceRoot: this.workspaceRoot,
          systemPrompt: options.systemPrompt,
          permission: {
            mode: this.permission.getMode(),
            decider: this.options.permission.decider,
            engine: this.permission, // shared rules, grants and mode
          },
          maxTurns: options.maxTurns ?? 20,
          logger: this.logger,
        });
        const result = await child.run(options.prompt, options.signal);
        return { finalText: result.finalText, turns: result.turns };
      } finally {
        this.activeSubagents -= 1;
      }
    },
  };
}
