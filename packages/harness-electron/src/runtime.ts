// Harness runtime: owns one AgentSession per chat-session ROUTE
// (`${sessionId}:${routeId}` — see route-cache.ts for the cache mechanics),
// rebuilds a route's session when settings change, and translates harness
// events into the host's streaming UI hooks. Tool activity is forwarded as
// structured parts via onTool (paired by id/toolCallId).
import fs from "node:fs/promises";
import path from "node:path";
import {
  AgentSession,
  createExecutionScope,
  type ExecutionScopeIdentity,
  type HarnessEvent,
  type HarnessPlugin,
  type Message,
  type PermissionDecider,
  type PermissionRequest,
  type Provider,
  type Tool,
  type ToolCallPart,
  type ToolResultPart,
} from "@innocencecode/harness-core";
import { createMockProvider } from "@innocencecode/provider-mock";
import { createOpenAIProvider } from "@innocencecode/provider-openai";
import { createAnthropicProvider } from "@innocencecode/provider-anthropic";
import {
  MOCK_GREETING,
  resolveActive,
  type HarnessSettings,
} from "./settings";
import { systemPromptFor } from "./agents";
import { decodeTranscript, encodeTurnV2, encodeTurnV3 } from "./transcript";
import {
  RouteSessionCache,
  routeCacheKey,
  sessionDisposedError,
} from "./route-cache";

export {
  IN_FLIGHT_BUILD_DISPOSE_TIMEOUT_MS,
  routeCacheKey,
} from "./route-cache";

export type AskResponse = "allow" | "allowSession" | "deny";

/** Route id plain chat turns run on; the transcript codec maps v2 rows here. */
export const DEFAULT_ROUTE_ID = "main";

export interface PermissionAsk {
  requestId: string;
  /** The persisted (redacted) permission request — raw args never reach the host. */
  call: PermissionRequest;
}

/** Structured tool event forwarded to the host (call and result arrive
 *  separately; pair them via id / toolCallId). */
export type LiveToolPart = ToolCallPart | (ToolResultPart & { durationMs: number });

/** Hooks the host implements to bridge UI, storage and dialogs. */
export interface RuntimeHooks {
  /** Text delta for the streaming assistant message. */
  onDelta(sessionId: string, messageId: string, delta: string): void;
  /** Structured tool events (call and result arrive separately; pair them via id/toolCallId). */
  onTool(sessionId: string, messageId: string, part: LiveToolPart): void;
  /** Thinking deltas (harness-core does not emit these yet; the channel is ready). */
  onThinking(sessionId: string, messageId: string, delta: string): void;
  onCompleted(sessionId: string, messageId: string): void;
  onError(sessionId: string, messageId: string, error: string): void;
  /** Ask the user about a tool call; resolves with their choice. */
  askPermission(sessionId: string, messageId: string, ask: PermissionAsk): Promise<AskResponse>;
  log(level: "info" | "warn" | "error", msg: string, data?: unknown): void;
}

/**
 * Late-bound view over the session's registered tools. Plugins are composed
 * BEFORE the AgentSession exists, so a host plugin that needs tool metadata
 * at execution time (e.g. the task capture middleware's lookupTool) receives
 * this index in its factory context; the runtime adopts the session's
 * registry right after the build, always before the first tool invocation.
 */
export interface SessionToolIndex {
  get(toolName: string): Tool | undefined;
}

export function createSessionToolIndex(): SessionToolIndex & {
  adopt(tools: ReadonlyMap<string, Tool>): void;
} {
  let adopted: ReadonlyMap<string, Tool> | undefined;
  return {
    get: (toolName) => adopted?.get(toolName),
    adopt(tools) {
      adopted = tools;
    },
  };
}

/**
 * Everything the host composition root needs to assemble one session's
 * plugin set. The runtime owns no concrete plugin — hosts (Electron glue,
 * CLI, tests) decide which capabilities each session gets.
 */
export interface PluginFactoryContext {
  /** Host-level chat session id (the route key's session part). */
  sessionId: string;
  /** Route the session serves (normalized; plain chat turns use "main"). */
  routeId: string;
  /** Task identity when the route belongs to a task; undefined for plain chat. */
  taskId?: string;
  /** Id of the message/turn that triggered this session build. */
  messageId: string;
  /** Settings value this session is built under (settings() at build time). */
  settings: HarnessSettings;
  /** Resolved workspace root (never empty; falls back to process.cwd()). */
  workspaceRoot: string;
  /**
   * Correlation scope for the session bootstrap: a fresh invocation id
   * stamped with the chat session + route (and task, when present) identity.
   */
  scope: ReturnType<typeof createExecutionScope>;
  /** Late-bound tool index; resolves names after the session's build. */
  toolIndex: SessionToolIndex;
}

/** One agent turn: route/task identity plus the user input and host message id. */
export interface RuntimeSendRequest {
  sessionId: string;
  /** Owning task id; "" for plain (non-task) chat turns. */
  taskId: string;
  routeId: string;
  text: string | Message;
  messageId: string;
}

export interface RuntimeOptions {
  settings(): HarnessSettings;
  hooks: RuntimeHooks;
  /** Host composition root: supplies the plugin set for each agent session. */
  pluginsForSession(
    context: PluginFactoryContext,
  ): Promise<HarnessPlugin[]> | HarnessPlugin[];
  /** Directory for JSONL session transcripts; omitted = no persistence. */
  persistDir?: string;
  /** Replaces the settings-based provider construction (test seam). */
  providerFactory?: (settings: HarnessSettings) => Provider;
  /**
   * Wraps the AgentSession construction (test seam): receives the factory
   * context plus the deferred default build, and must produce the session
   * that enters the route cache.
   */
  agentFactory?: (
    context: PluginFactoryContext,
    create: () => Promise<AgentSession>,
  ) => Promise<AgentSession>;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** Build context the cache's build callback needs, keyed by cache key. */
interface RouteBuildContext {
  sessionId: string;
  routeId: string;
  taskId: string;
  messageId: string;
}

/**
 * Owns one AgentSession per chat-session route, rebuilt when settings
 * change, and translates harness events into the host's streaming UI hooks.
 */
export class HarnessRuntime {
  private readonly options: RuntimeOptions;
  private readonly cache: RouteSessionCache;
  private readonly buildContexts = new Map<string, RouteBuildContext>();

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.cache = new RouteSessionCache({
      build: (key) => this.buildSession(key),
      settleDispose: (key, session) => this.settleDispose(key, session),
      log: (level, msg, data) => this.options.hooks.log(level, msg, data),
    });
  }

  /**
   * Runs one agent turn on the request's route. `messageId` is supplied by
   * the host so the IPC handler can return it synchronously before the turn
   * completes. Task identity (non-empty taskId) is stamped on every tool
   * invocation scope of the run, so task middleware can attribute effects.
   */
  async send(request: RuntimeSendRequest): Promise<void> {
    const routeId = request.routeId || DEFAULT_ROUTE_ID;
    const key = routeCacheKey(request.sessionId, routeId);
    const controller = new AbortController();
    this.cache.startRun(key, controller);

    try {
      const agent = await this.agentFor(
        request.sessionId,
        routeId,
        request.taskId,
        request.messageId,
      );
      const historyStart = agent.history.length;
      const unsubscribe = agent.on((event) =>
        this.forwardEvent(request.sessionId, request.messageId, event),
      );
      try {
        const identity: ExecutionScopeIdentity = request.taskId
          ? { sessionId: request.sessionId, taskId: request.taskId, routeId }
          : { sessionId: request.sessionId, routeId };
        await agent.run(request.text, controller.signal, identity);
      } finally {
        unsubscribe();
        this.cache.endRun(key);
      }
      this.options.hooks.onCompleted(request.sessionId, request.messageId);
      await this.persistTurn(
        request.sessionId,
        request.messageId,
        routeId,
        request.taskId,
        agent.history.slice(historyStart),
      );
    } catch (err) {
      this.options.hooks.onError(
        request.sessionId,
        request.messageId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Stops the active run of one route — or every route of the chat session
   *  when the route is omitted (user-level stop). */
  stop(sessionId: string, routeId?: string): void {
    if (routeId === undefined) this.cache.abortSession(sessionId);
    else this.cache.abort(routeCacheKey(sessionId, routeId));
  }

  /**
   * Releases one route's agent resources (or every route of the chat
   * session when the route is omitted): aborts any active run, waits for it
   * to settle and disposes the session's plugins. Deleting a cache entry
   * alone is not resource cleanup. Never rejects — disposal failures are
   * reported through the log hook. See RouteSessionCache.dispose for the
   * in-flight build/tombstone semantics.
   */
  async dispose(sessionId: string, routeId?: string): Promise<void> {
    if (routeId === undefined) await this.cache.disposeSession(sessionId);
    else await this.cache.dispose(routeCacheKey(sessionId, routeId));
  }

  /** Releases every cached agent session and every in-flight build (e.g. app shutdown). */
  async disposeAll(): Promise<void> {
    await this.cache.disposeAll();
  }

  private async settleDispose(key: string, session: AgentSession): Promise<void> {
    this.buildContexts.delete(key);
    try {
      await session.dispose();
    } catch (err) {
      this.options.hooks.log("error", "session dispose failed", `${key}: ${String(err)}`);
    }
  }

  private agentFor(
    sessionId: string,
    routeId: string,
    taskId: string,
    messageId: string,
  ): Promise<AgentSession> {
    const key = routeCacheKey(sessionId, routeId);
    // The initiating send's context wins: the cache calls build(key)
    // synchronously when no build is in flight, so the context is always
    // set before the (single, deduplicated) build reads it.
    this.buildContexts.set(key, { sessionId, routeId, taskId, messageId });
    return this.cache.agentFor(key);
  }

  private async buildSession(key: string): Promise<AgentSession> {
    const context = this.buildContexts.get(key);
    if (!context) throw sessionDisposedError(key);
    const { sessionId, routeId, taskId, messageId } = context;
    const settings = this.options.settings();
    const settingsKey = JSON.stringify(settings);
    const cached = this.cache.peek(key);
    if (cached && cached.settingsKey === settingsKey) return cached.session;

    const workspaceRoot = settings.workspaceRoot || process.cwd();

    const decider: PermissionDecider = {
      ask: async (request) => {
        const ask: PermissionAsk = { requestId: nextId("perm"), call: request };
        const answer = await this.options.hooks.askPermission(sessionId, messageId, ask);
        return answer;
      },
    };

    const toolIndex = createSessionToolIndex();
    // Plugins come from the host composition root — the runtime owns no
    // concrete capability, so tools/skills/MCP wiring lives in the host.
    const factoryContext: PluginFactoryContext = {
      sessionId,
      routeId,
      taskId: taskId || undefined,
      messageId,
      settings,
      workspaceRoot,
      scope: createExecutionScope("session", undefined, {
        sessionId,
        routeId,
        ...(taskId ? { taskId } : {}),
      }),
      toolIndex,
    };
    const plugins = await this.options.pluginsForSession(factoryContext);

    const create = () =>
      AgentSession.create({
        plugins,
        provider:
          this.options.providerFactory?.(settings) ?? this.buildProvider(settings),
        workspaceRoot,
        systemPrompt: systemPromptFor(settings.activeAgent ?? "default"),
        permission: {
          mode: settings.permissionMode,
          decider,
          // Every resolution (including full mode) is audited through the host
          // log with the persisted request — raw args never reach this surface.
          audit: (entry) => {
            this.options.hooks.log("info", "permission", {
              mode: entry.mode,
              tool: entry.request.toolName,
              resource: `${entry.request.resource.action}:${entry.request.resource.kind}:${entry.request.resource.scope}`,
              decision: entry.resolution.decision,
              via: entry.resolution.via,
            });
          },
        },
        logger: (level, msg, data) => this.options.hooks.log(level, msg, data),
      });
    const session = await (this.options.agentFactory?.(factoryContext, create) ?? create());
    // The session exists now, so its registry can back the late-bound index.
    toolIndex.adopt(session.registry.tools);

    if (cached) {
      // Rebuilds (settings changed) keep the conversation: copy the previous
      // session's canonical history FIRST, then release the old session —
      // dispose aborts its in-flight work, so the snapshot must not depend
      // on anything that teardown touches.
      session.history.push(
        ...cached.session.history.map((m) => ({ role: m.role, parts: [...m.parts] })),
      );
    } else if (this.options.persistDir && routeId === DEFAULT_ROUTE_ID) {
      // Fresh runtime after app restart: the MAIN route seeds from the
      // canonical transcript codec (never renderer/UI-coalesced messages).
      // Non-main routes keep an empty history — their durable state is the
      // task system's (turn commit), not the chat transcript.
      try {
        const raw = await fs.readFile(
          path.join(this.options.persistDir, `${sessionId}.jsonl`),
          "utf8",
        );
        const prior = decodeTranscript(raw).history;
        if (prior.length > 0) {
          session.history.push(...prior.map((m) => ({ role: m.role, parts: [...m.parts] })));
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          this.options.hooks.log("warn", "history seed failed", String(err));
        }
      }
    }
    if (this.cache.isDisposing(key)) {
      // dispose() arrived while this build was in flight: release the
      // product in place — it must never enter the cache or run a turn.
      // (The previously cached session, if any, was already released by
      // dispose() itself.)
      await this.cache.releaseInPlace(key, session);
      throw sessionDisposedError(key);
    }
    this.cache.commit(key, settingsKey, session);
    if (cached) {
      // dispose() may have released this old entry mid-build; the second
      // call is an idempotent no-op (session dispose deduplicates).
      await this.settleDispose(key, cached.session);
    }
    return session;
  }

  private buildProvider(settings: HarnessSettings) {
    const active = resolveActive(settings);
    // 空串 = 跟随模型默认（不传参）；off 交给 provider 层解释（openai 省略、anthropic 不开启）。
    const reasoningEffort = settings.reasoningEffort || undefined;
    switch (active.kind) {
      case "openai":
        return createOpenAIProvider({
          apiKey: active.apiKey || undefined,
          baseURL: active.baseURL || undefined,
          model: active.model,
          reasoningEffort,
        });
      case "anthropic":
        return createAnthropicProvider({
          apiKey: active.apiKey || undefined,
          model: active.model,
          reasoningEffort,
        });
      default:
        return createMockProvider({ id: "mock", turns: [], exhaustedText: MOCK_GREETING });
    }
  }

  private forwardEvent(sessionId: string, messageId: string, event: HarnessEvent): void {
    const hooks = this.options.hooks;
    switch (event.type) {
      case "token":
        hooks.onDelta(sessionId, messageId, event.text);
        break;
      case "thinking":
        hooks.onThinking(sessionId, messageId, event.text);
        break;
      case "toolCall":
        hooks.onTool(sessionId, messageId, {
          type: "toolCall",
          id: event.id,
          toolName: event.call.toolName,
          args: event.call.args,
        });
        break;
      case "toolResult":
        hooks.onTool(sessionId, messageId, {
          type: "toolResult",
          toolCallId: event.toolCallId,
          content: event.content,
          isError: event.isError === true,
          durationMs: event.durationMs,
        });
        break;
      case "compaction":
        hooks.onDelta(sessionId, messageId, "\n\n> 🗜️ 已压缩较早的对话历史\n");
        break;
      case "error":
        hooks.onDelta(sessionId, messageId, `\n\n> ⚠️ ${event.message}\n`);
        break;
      default:
        break;
    }
  }

  /**
   * Persists one completed turn of a route. Task-scoped turns are SKIPPED —
   * the task commit flow (TurnCommitCoordinator + transcript sink) owns
   * their durable turn-v3 rows, so the runtime must never double-write
   * them. Non-task turns: the main route keeps turn-v2 (host hydration
   * depends on it); other routes append turn-v3 rows with explicit route
   * identity (empty checkpointId — no checkpoint backs a non-task turn),
   * which the decoder keeps OUT of the main history.
   */
  private async persistTurn(
    sessionId: string,
    turnId: string,
    routeId: string,
    taskId: string,
    messages: Message[],
  ): Promise<void> {
    if (!this.options.persistDir || messages.length === 0 || taskId) return;
    try {
      await fs.mkdir(this.options.persistDir, { recursive: true });
      const line =
        routeId === DEFAULT_ROUTE_ID
          ? encodeTurnV2(turnId, new Date().toISOString(), messages)
          : encodeTurnV3({
              at: new Date().toISOString(),
              eventId: nextId("event"),
              turnId,
              routeId,
              parentTurnId: null,
              checkpointId: "",
              messages,
            });
      await fs.appendFile(path.join(this.options.persistDir, `${sessionId}.jsonl`), line, "utf8");
    } catch (err) {
      this.options.hooks.log("warn", "persist failed", String(err));
    }
  }
}
