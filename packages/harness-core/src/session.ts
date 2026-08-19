import { ContextManager } from "./context-manager";
import {
  nextRouteId,
  nextSessionId,
  type ExecutionScopeIdentity,
} from "./execution-scope";
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
import { processMessage } from "./processor";
import { PluginRegistry, type HarnessPlugin, type Logger } from "./registry";
import type { Provider } from "./provider";
import { textMessage, type Message, type MessagePart } from "./types";
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

/** Converts the run input into a canonical user message or throws. */
function canonicalUserMessage(input: string | Message): Message {
  const message = typeof input === "string" ? textMessage("user", input) : input;
  if (message.role !== "user") {
    throw new Error(`AgentSession.run() only accepts user messages (got "${message.role}")`);
  }
  return message;
}

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
  readonly sessionId: string;
  readonly history: Message[] = [];
  readonly options: AgentSessionOptions;

  private baseSystemPrompt: string;
  private compactor: ContextManager;
  private listeners = new Set<HarnessEventListener>();
  private abort: AbortController | undefined;
  private activeRun: Promise<unknown> | undefined;
  private logger: Logger;
  private activeSubagents = 0;
  /** Set as soon as dispose() starts: a released session never runs again. */
  private disposed = false;

  private constructor(
    options: AgentSessionOptions,
    registry: PluginRegistry,
    provider: Provider,
  ) {
    this.options = options;
    this.registry = registry;
    this.provider = provider;
    this.workspaceRoot = options.workspaceRoot;
    this.sessionId = nextSessionId();
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

  /**
   * Runs skill expansion over the canonical input. Only the targeted text
   * parts change; every other part is kept as-is, in order.
   */
  private async expandUserMessage(message: Message): Promise<Message> {
    if (this.registry.skills.size === 0) return message;
    const parts: MessagePart[] = [];
    for (const part of message.parts) {
      if (part.type === "text") {
        parts.push({ type: "text", text: await this.expandUserText(part.text) });
      } else {
        parts.push(part);
      }
    }
    return { role: message.role, parts };
  }

  /**
   * One user-initiated run. A string input becomes a canonical single-text
   * user message; a Message must already be `role: "user"`. The canonical
   * input is skill-expanded and processor-run BEFORE entering the loop; the
   * tool-result user turns the loop pushes afterwards never pass through
   * processors. `scopePatch` overrides the run's inherited identity
   * (sessionId/taskId/routeId/parentInvocationId) stamped on every tool
   * invocation scope of this run.
   */
  async run(
    input: string | Message,
    signal?: AbortSignal,
    scopePatch: ExecutionScopeIdentity = {},
  ): Promise<RunSummary> {
    if (this.disposed) {
      throw new Error(`会话已释放（${this.sessionId}），不能再运行`);
    }
    const canonical = canonicalUserMessage(input);
    const abort = new AbortController();
    this.abort = abort;
    if (signal) {
      if (signal.aborted) abort.abort();
      else signal.addEventListener("abort", () => abort.abort(), { once: true });
    }
    const sessionId = scopePatch.sessionId ?? this.sessionId;
    const runScope: ExecutionScopeIdentity = {
      sessionId,
      taskId: scopePatch.taskId,
      routeId: scopePatch.routeId ?? nextRouteId(),
      parentInvocationId: scopePatch.parentInvocationId,
    };
    // The run promise is created and published to activeRun synchronously,
    // BEFORE the first await: a dispose() racing the entry phase (skill
    // expansion / message processing) must wait for this run to settle
    // instead of releasing the registry underneath it.
    const running = this.executeRun(canonical, runScope, abort, sessionId);
    this.activeRun = running;
    try {
      return await running;
    } finally {
      this.activeRun = undefined;
      this.abort = undefined;
    }
  }

  /** Expansion + processing + loop — the promise activeRun tracks. */
  private async executeRun(
    canonical: Message,
    runScope: ExecutionScopeIdentity,
    abort: AbortController,
    sessionId: string,
  ): Promise<RunSummary> {
    const expanded = await this.expandUserMessage(canonical);
    const processed = await processMessage(expanded, this.registry.messageProcessors, {
      signal: abort.signal,
      provider: this.provider,
      scope: { sessionId },
    });
    return runLoop(this.history, processed, {
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
      signal: abort.signal,
      maxTurns: this.options.maxTurns ?? DEFAULT_MAX_TURNS,
      toolTimeoutMs: this.options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      spawner: this.spawner,
      scope: runScope,
    });
  }

  stop(): void {
    this.abort?.abort();
  }

  /**
   * Aborts the active run, waits for it to settle, then disposes all plugins.
   * The disposed flag flips first, so run() calls racing this teardown reject
   * with 会话已释放 instead of driving a released registry. Idempotent:
   * repeat calls join the same cleanup (registry disposal deduplicates).
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.abort?.abort();
    if (this.activeRun) {
      await this.activeRun.catch(() => {});
    }
    await this.registry.dispose();
  }

  /**
   * Spawns a nested agent session sharing this session's provider, permission
   * engine (so child tool calls hit the same approval flow) and workspace,
   * with its own isolated message history. The child registers the SAME
   * message processors and tool middlewares as this session, and runs under
   * the parent's scope identity with the spawning invocation as
   * parentInvocationId. Concurrency-capped; the child session is disposed in
   * a finally once its run settles.
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
        // Same registration set as the parent: identical processor and
        // middleware objects, in the parent's registration order.
        const inheritPlugin: HarnessPlugin = {
          name: "subagent-inherit",
          activate: (ctx) => {
            for (const processor of this.registry.messageProcessors) {
              ctx.registerMessageProcessor(processor);
            }
            for (const middleware of this.registry.toolMiddlewares) {
              ctx.registerToolMiddleware(middleware);
            }
          },
        };
        const parent = options.parentScope;
        const child = await AgentSession.create({
          plugins: [toolsPlugin, inheritPlugin],
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
        try {
          const result = await child.run(options.prompt, options.signal, {
            sessionId: parent?.sessionId ?? this.sessionId,
            taskId: parent?.taskId,
            routeId: parent?.routeId ?? nextRouteId(),
            parentInvocationId: parent?.invocationId,
          });
          return { finalText: result.finalText, turns: result.turns };
        } finally {
          // A dispose failure must never mask the child run's own outcome —
          // log and swallow it (create's rollback path does the same).
          await child.dispose().catch((disposeError) => {
            this.logger("error", "subagent child dispose failed", disposeError);
          });
        }
      } finally {
        this.activeSubagents -= 1;
      }
    },
  };
}
