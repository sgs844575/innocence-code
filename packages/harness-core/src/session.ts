// AgentSession: the host-facing conversational session. The shell API is
// unchanged; internally the session is one kernel Context carrying the spine
// services (tools/permissions/providers/skills/session/system-prompt/agents/
// spawner) with the HarnessPluginAdapter bridging legacy HarnessPlugins onto
// them (see session-kernel.ts / session-adapter.ts / session-registry-view.ts).
import {
  createRunLoop,
  DEFAULT_MAX_TURNS,
  DEFAULT_TOOL_TIMEOUT_MS,
  type RunLoopFunction,
} from "@innocencecode/harness-agent-loop";
import {
  nextRouteId,
  nextSessionId,
  type ExecutionScopeIdentity,
} from "./execution-scope";
import type { HarnessEventListener } from "./events";
import type {
  PermissionAuditor,
  PermissionDecider,
  PermissionEngine,
  ResourceValidator,
} from "./permission";
import type { ProjectPermissionConfig } from "./policy-config";
import type { PermissionMode } from "./policy";
import type { Provider } from "./provider";
import type { HarnessPlugin, Logger } from "./registry";
import { mountSessionKernel, type SessionKernel } from "./session-kernel";
import type { SessionRegistryView } from "./session-registry-view";
import { createSpawnerChildSession, makeSessionSpawner } from "./session-spawner";
import { textMessage, type Message, type MessagePart } from "./types";
import type { SubagentSpawner } from "./subagent";

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
 * Ties the kernel context, spine services, provider, permission engine,
 * compactor and event stream into one conversational session. Hosts
 * (Electron, CLI, tests) subscribe to events and inject the permission
 * decider.
 */
export class AgentSession {
  readonly registry: SessionRegistryView;
  readonly permission: PermissionEngine;
  readonly provider: Provider;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly history: Message[];
  readonly options: AgentSessionOptions;

  private readonly kernel: SessionKernel;
  private readonly loop: RunLoopFunction;
  private readonly listeners = new Set<HarnessEventListener>();
  private readonly logger: Logger;
  private abort: AbortController | undefined;
  private activeRun: Promise<unknown> | undefined;
  /** Set as soon as dispose() starts: a released session never runs again. */
  private disposed = false;
  private disposeInFlight: Promise<void> | undefined;
  private disposeSettled = false;

  private constructor(options: AgentSessionOptions, kernel: SessionKernel, sessionId: string) {
    this.options = options;
    this.kernel = kernel;
    this.registry = kernel.view;
    this.permission = kernel.services.permissions.engine;
    this.provider = kernel.provider;
    this.workspaceRoot = options.workspaceRoot;
    this.sessionId = sessionId;
    this.history = kernel.services.session.history;
    this.logger = options.logger ?? noopLogger;
    this.spawner = makeSessionSpawner(kernel.services.spawner, sessionId, kernel.view);
    this.loop = createRunLoop({
      tools: kernel.services.tools,
      permission: this.permission,
      provider: this.provider,
      history: this.history,
      systemPrompt: () => this.buildSystemPrompt(),
      workspaceRoot: this.workspaceRoot,
      onEvent: (event) => kernel.services.session.emit(event),
      compactor: kernel.services.session.compactor,
      spawner: this.spawner,
      maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
      toolTimeoutMs: options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    });
    // HarnessEvent traffic flows over the kernel bus: the session service
    // emits, this root-level subscription fans out to the on() listeners and
    // keeps the error-to-logger semantics.
    kernel.ctx.on("harness/event", (event) => {
      for (const listener of this.listeners) listener(event);
      if (event.type === "error") this.logger("error", event.message);
    });
  }

  static async create(options: AgentSessionOptions): Promise<AgentSession> {
    const sessionId = nextSessionId();
    const kernel = await mountSessionKernel({
      sessionId,
      plugins: options.plugins,
      provider: options.provider,
      providerId: options.providerId,
      workspaceRoot: options.workspaceRoot,
      systemPrompt: options.systemPrompt,
      permission: options.permission,
      compaction: options.compaction,
      logger: options.logger ?? noopLogger,
      spawnerSessionFactory: (materials) => createSpawnerChildSession(options, materials),
    });
    return new AgentSession(options, kernel, sessionId);
  }

  on(listener: HarnessEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSystemPrompt(prompt: string): void {
    this.kernel.services.systemPrompt.setBase(prompt);
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permission.setMode(mode);
  }

  /** Base prompt + registered sections + the skills index (descriptions only). */
  private buildSystemPrompt(): string {
    return this.kernel.services.systemPrompt.build(this.kernel.services.skills.all());
  }

  /** Expands "/skillname ..." input by loading the skill body as context. */
  private async expandUserText(text: string): Promise<string> {
    const match = /^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/.exec(text.trim());
    if (!match) return text;
    const skill = this.kernel.services.skills.get(match[1]);
    if (!skill) return text;
    const body = await skill.loadBody();
    return `[已加载技能 ${skill.name}]\n${body}\n\n[用户输入]\n${match[2]}`;
  }

  /**
   * Runs skill expansion over the canonical input. Only the targeted text
   * parts change; every other part is kept as-is, in order.
   */
  private async expandUserMessage(message: Message): Promise<Message> {
    if (this.kernel.services.skills.all().length === 0) return message;
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
    // instead of releasing the kernel underneath it.
    const running = this.executeRun(canonical, runScope, abort);
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
  ): Promise<RunSummary> {
    const expanded = await this.expandUserMessage(canonical);
    const processed = await this.kernel.services.session.processUserInput(
      expanded,
      abort.signal,
    );
    return this.loop(processed, { signal: abort.signal, scope: runScope });
  }

  stop(): void {
    this.abort?.abort();
  }

  /**
   * Aborts the active run, waits for it to settle, then disposes the kernel
   * context (every plugin and effect, reverse activation order). The
   * disposed flag flips first, so run() calls racing this teardown reject
   * with 会话已释放 instead of driving a released kernel. Idempotent:
   * repeat calls join the same cleanup and never replay its outcome.
   */
  async dispose(): Promise<void> {
    if (this.disposeSettled) return;
    if (this.disposeInFlight) return this.disposeInFlight;
    this.disposed = true;
    this.abort?.abort();
    const active = this.activeRun;
    this.disposeInFlight = this.settleKernel(active);
    try {
      await this.disposeInFlight;
    } finally {
      this.disposeInFlight = undefined;
      this.disposeSettled = true;
    }
  }

  /**
   * Unwinds the kernel and surfaces plugin dispose failures with the legacy
   * registry's shape (AggregateError, `plugin dispose failed: ...`) so hosts
   * observing session.dispose() rejections keep their error-level handling.
   */
  private async settleKernel(active: Promise<unknown> | undefined): Promise<void> {
    if (active) await active.catch(() => {});
    const errors: unknown[] = [];
    try {
      await this.kernel.ctx.fiber.dispose();
    } catch (error) {
      errors.push(error);
    }
    for (const fiber of this.kernel.pluginFibers) {
      errors.push(...fiber.unwindErrors);
    }
    if (errors.length > 0) {
      const detail = errors
        .map((error) => (error instanceof Error ? error.message : String(error)))
        .join("; ");
      throw new AggregateError(errors, `plugin dispose failed: ${detail}`);
    }
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
  readonly spawner: SubagentSpawner;
}

