// Harness runtime: owns one AgentSession per chat-session ROUTE
// (`${sessionId}:${routeId}` — see route-cache.ts for the cache mechanics),
// rebuilds a route's session when settings change, and translates harness
// events into the host's streaming UI hooks. Types live in runtime-types.ts,
// provider construction in provider-builder.ts, transcript persistence in
// turn-persistence.ts.
import fs from "node:fs/promises";
import path from "node:path";
import type { Route } from "@innocencecode/task-core";
import {
  AgentSession,
  createExecutionScope,
  type ExecutionScopeIdentity,
  type PermissionDecider,
} from "@innocencecode/harness-core";
import { decodeTranscript } from "./transcript";
import { systemPromptFor } from "./agents";
import { buildProviderFromSettings } from "./provider-builder";
import { persistTurn } from "./turn-persistence";
import { forwardHarnessEvent } from "./runtime-events";
import { RouteSessionCache, routeCacheKey, sessionDisposedError } from "./route-cache";
import {
  createSessionToolIndex,
  DEFAULT_ROUTE_ID,
  type PermissionAsk,
  type PluginFactoryContext,
  type RuntimeForkRouteInput,
  type RuntimeOptions,
  type RuntimeSendRequest,
} from "./runtime-types";

export * from "./runtime-types";
export {
  IN_FLIGHT_BUILD_DISPOSE_TIMEOUT_MS,
  routeCacheKey,
} from "./route-cache";

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
        forwardHarnessEvent(this.options.hooks, request.sessionId, request.messageId, event),
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
      await persistTurn(
        { persistDir: this.options.persistDir, log: (level, msg, data) => this.options.hooks.log(level, msg, data) },
        {
          sessionId: request.sessionId,
          turnId: request.messageId,
          routeId,
          taskId: request.taskId,
          messages: agent.history.slice(historyStart),
        },
      );
    } catch (err) {
      this.options.hooks.onError(
        request.sessionId,
        request.messageId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async forkRoute(input: RuntimeForkRouteInput): Promise<Route> {
    if (!this.options.forkRoute) throw new Error("forkRoute host port is not configured");
    return this.options.forkRoute(input);
  }

  /** Stops the active run of one route (empty routeId = the main route,
   *  like send; omitted route = every route of the chat session). */
  stop(sessionId: string, routeId?: string): void {
    if (routeId === undefined) this.cache.abortSession(sessionId);
    else this.cache.abort(routeCacheKey(sessionId, routeId || DEFAULT_ROUTE_ID));
  }

  /**
   * Releases one route's agent resources (empty routeId = the main route,
   * like send; omitted route = every route of the chat session): aborts any
   * active run, waits for it to settle and disposes the session's plugins.
   * Deleting a cache entry alone is not resource cleanup. Never rejects —
   * disposal failures are reported through the log hook. See
   * RouteSessionCache.dispose for the in-flight build/tombstone semantics.
   */
  async dispose(sessionId: string, routeId?: string): Promise<void> {
    if (routeId === undefined) await this.cache.disposeSession(sessionId);
    else await this.cache.dispose(routeCacheKey(sessionId, routeId || DEFAULT_ROUTE_ID));
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

  private async agentFor(
    sessionId: string,
    routeId: string,
    taskId: string,
    messageId: string,
  ): Promise<AgentSession> {
    const key = routeCacheKey(sessionId, routeId);
    const context: RouteBuildContext = { sessionId, routeId, taskId, messageId };
    // The initiating send's context wins: the cache calls build(key)
    // synchronously when no build is in flight, so the context is always
    // set before the (single, deduplicated) build reads it.
    this.buildContexts.set(key, context);
    try {
      return await this.cache.agentFor(key);
    } catch (err) {
      // A failed build must not pin its context: the next send overwrites
      // it anyway, but deleting keeps failed keys from accumulating.
      if (this.buildContexts.get(key) === context) this.buildContexts.delete(key);
      throw err;
    }
  }

  private async buildSession(key: string): Promise<AgentSession> {
    const context = this.buildContexts.get(key);
    if (!context) throw sessionDisposedError(key);
    const { sessionId, routeId, taskId, messageId } = context;
    const settings = this.options.settings();
    const settingsKey = JSON.stringify(settings);
    const cached = this.cache.peek(key);
    if (cached && cached.settingsKey === settingsKey) return cached.session;

    // Route-scoped root FIRST (task worktree / session-bound project):
    // plugins, permission scopes and the session itself all act on it. An
    // absent hook or empty result keeps the settings root.
    const settingsRoot = settings.workspaceRoot || process.cwd();
    const routeRoot = await this.options.workspaceRootFor?.({
      sessionId,
      routeId,
      taskId: taskId || undefined,
      messageId,
    });
    const workspaceRoot = routeRoot || settingsRoot;

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
          this.options.providerFactory?.(settings) ?? buildProviderFromSettings(settings),
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
}
