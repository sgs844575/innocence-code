import fs from "node:fs/promises";
import path from "node:path";
import {
  AgentSession,
  createExecutionScope,
  type ExecutionScope,
  type HarnessEvent,
  type HarnessPlugin,
  type Message,
  type PermissionDecider,
  type PermissionRequest,
  type Provider,
  type ToolCallPart,
  type ToolResultPart,
} from "@innocencecode/harness-core";
import { createMockProvider } from "@innocencecode/provider-mock";
import { createOpenAIProvider } from "@innocencecode/provider-openai";
import { createAnthropicProvider } from "@innocencecode/provider-anthropic";
import {
  DEFAULT_SYSTEM_PROMPT,
  MOCK_GREETING,
  resolveActive,
  type HarnessSettings,
} from "./settings";
import { decodeTranscript, encodeTurnV2 } from "./transcript";

export type AskResponse = "allow" | "allowSession" | "deny";

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
 * Everything the host composition root needs to assemble one session's
 * plugin set. The runtime owns no concrete plugin — hosts (Electron glue,
 * CLI, tests) decide which capabilities each session gets.
 */
export interface PluginFactoryContext {
  /** Host-level chat session id (the runtime's cache key). */
  sessionId: string;
  /** Id of the message/turn that triggered this session build. */
  messageId: string;
  /** Settings value this session is built under (settings() at build time). */
  settings: HarnessSettings;
  /** Resolved workspace root (never empty; falls back to process.cwd()). */
  workspaceRoot: string;
  /**
   * Correlation scope for the session bootstrap: a fresh invocation id
   * stamped with the chat session identity (no tool is involved).
   */
  scope: ExecutionScope;
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
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/**
 * How long dispose() waits for an in-flight session build before giving up
 * (app quit must not hang on a stuck MCP spawn). The dispose tombstone
 * already guarantees the late build releases its own product, so expiry
 * only ends the wait — it never leaks on its own.
 */
export const IN_FLIGHT_BUILD_DISPOSE_TIMEOUT_MS = 10_000;

/**
 * Fail-fast error for a turn targeting a chat session that dispose() owns
 * (in progress or timed out): its build is doomed, so the turn errors via
 * onError immediately instead of parking on a promise that never settles.
 */
const sessionDisposedError = (chatSessionId: string): Error =>
  new Error(`会话已释放（${chatSessionId}），本轮已取消，请重建会话`);

/**
 * Owns one AgentSession per chat session, rebuilt when settings change, and
 * translates harness events into the host's streaming UI hooks. Tool activity
 * is forwarded as structured parts via onTool (paired by id/toolCallId).
 */
export class HarnessRuntime {
  private readonly options: RuntimeOptions;
  private readonly sessions = new Map<string, { key: string; session: AgentSession }>();
  /** In-flight session builds, keyed by chat session id (build dedup). */
  private readonly building = new Map<string, Promise<AgentSession>>();
  /** Chat session ids whose dispose() arrived while a build was in flight. */
  private readonly disposing = new Set<string>();
  private readonly running = new Map<string, AbortController>();

  constructor(options: RuntimeOptions) {
    this.options = options;
  }

  /**
   * Runs one agent turn. `messageId` is supplied by the host so the IPC
   * handler can return it synchronously before the turn completes.
   */
  async send(chatSessionId: string, text: string, messageId: string): Promise<void> {
    const controller = new AbortController();
    this.running.set(chatSessionId, controller);

    try {
      const agent = await this.agentFor(chatSessionId, messageId);
      const historyStart = agent.history.length;
      const unsubscribe = agent.on((event) =>
        this.forwardEvent(chatSessionId, messageId, event),
      );
      try {
        await agent.run(text, controller.signal);
      } finally {
        unsubscribe();
        this.running.delete(chatSessionId);
      }
      this.options.hooks.onCompleted(chatSessionId, messageId);
      await this.persistTurn(chatSessionId, messageId, agent.history.slice(historyStart));
    } catch (err) {
      this.options.hooks.onError(
        chatSessionId,
        messageId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  stop(chatSessionId: string): void {
    this.running.get(chatSessionId)?.abort();
  }

  /**
   * Releases one chat session's agent resources: aborts any active run,
   * waits for it to settle and disposes the session's plugins. Deleting a
   * cache entry alone is not resource cleanup. Never rejects — disposal
   * failures are reported through the log hook.
   *
   * A build can be in flight (its awaits span plugin factories and
   * AgentSession.create — MCP spawns take seconds): dispose then releases
   * the cached entry immediately, marks the id so the landing build releases
   * its own product instead of caching it, and waits for that to happen —
   * BOUNDED by IN_FLIGHT_BUILD_DISPOSE_TIMEOUT_MS so a hung spawn cannot
   * hang the quit path. A session built for a deleted chat id therefore
   * never leaks and its triggering send fails fast with 会话已释放.
   */
  async dispose(chatSessionId: string): Promise<void> {
    const inFlight = this.building.get(chatSessionId);
    if (!inFlight) {
      await this.releaseCached(chatSessionId);
      return;
    }
    // Tombstone FIRST (synchronously): the build's landing check must see
    // it even if it races past this point while we release the old entry.
    this.disposing.add(chatSessionId);
    await this.releaseCached(chatSessionId);
    await this.waitBuildForDisposal(chatSessionId, inFlight);
  }

  /**
   * Bounded wait for an in-flight build during dispose. Resolves when the
   * build settles (tombstone lifted here) or the bound expires (error logged;
   * the tombstone must then OUTLIVE this call — a late landing product must
   * still see it and self-release — so its removal is handed to the build's
   * landing). Never rejects.
   */
  private async waitBuildForDisposal(
    chatSessionId: string,
    inFlight: Promise<AgentSession>,
  ): Promise<void> {
    let settleTombstone = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        inFlight,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            settleTombstone = false;
            this.options.hooks.log(
              "error",
              "dispose timed out waiting for in-flight build",
              chatSessionId,
            );
            // Lift the tombstone once the stuck build eventually lands (ok
            // or failed) so future sends can rebuild; until then it stays
            // visible and the landing product self-releases.
            const lift = () => this.disposing.delete(chatSessionId);
            inFlight.then(lift, lift);
            resolve();
          }, IN_FLIGHT_BUILD_DISPOSE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // The build failed or was cancelled by this dispose — its product is
      // already released (or never existed); nothing more to clean up.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (settleTombstone) this.disposing.delete(chatSessionId);
    }
  }

  /** Releases every cached agent session and every in-flight build (e.g. app shutdown). */
  async disposeAll(): Promise<void> {
    // In-flight builds first: dispose() makes each landing product release
    // itself instead of re-populating the cache after the sweep below.
    const building = [...this.building.keys()];
    await Promise.all(building.map((id) => this.dispose(id)));
    const entries = [...this.sessions];
    this.sessions.clear();
    await Promise.all(
      entries.map(([chatSessionId, entry]) => this.settleDispose(chatSessionId, entry.session)),
    );
  }

  private async releaseCached(chatSessionId: string): Promise<void> {
    const cached = this.sessions.get(chatSessionId);
    if (!cached) return;
    this.sessions.delete(chatSessionId);
    await this.settleDispose(chatSessionId, cached.session);
  }

  private async settleDispose(chatSessionId: string, session: AgentSession): Promise<void> {
    try {
      await session.dispose();
    } catch (err) {
      this.options.hooks.log("error", "session dispose failed", `${chatSessionId}: ${String(err)}`);
    }
  }

  /**
   * Resolves the agent session for one chat session. Concurrent sends share
   * a single in-flight build: a dropped losing build would leak its plugins
   * (e.g. an MCP child-process tree nobody disposes). EXCEPTION: while
   * dispose() owns the id (including the post-timeout window, where the
   * stuck build never settles), joining that build would park the new turn
   * forever on a session that is already doomed — fail fast instead.
   */
  private agentFor(chatSessionId: string, messageId: string): Promise<AgentSession> {
    if (this.disposing.has(chatSessionId)) {
      throw sessionDisposedError(chatSessionId);
    }
    const inFlight = this.building.get(chatSessionId);
    if (inFlight) return inFlight;

    const settled = this.buildSession(chatSessionId, messageId).finally(() => {
      // Cleared on settle so failures never pin a rejected promise: a later
      // send retries the build instead of replaying the old outcome.
      if (this.building.get(chatSessionId) === settled) {
        this.building.delete(chatSessionId);
      }
    });
    this.building.set(chatSessionId, settled);
    return settled;
  }

  private async buildSession(
    chatSessionId: string,
    messageId: string,
  ): Promise<AgentSession> {
    const settings = this.options.settings();
    const key = JSON.stringify(settings);
    const cached = this.sessions.get(chatSessionId);
    if (cached && cached.key === key) return cached.session;

    const workspaceRoot = settings.workspaceRoot || process.cwd();

    const decider: PermissionDecider = {
      ask: async (request) => {
        const ask: PermissionAsk = { requestId: nextId("perm"), call: request };
        const answer = await this.options.hooks.askPermission(chatSessionId, messageId, ask);
        return answer;
      },
    };

    // Plugins come from the host composition root — the runtime owns no
    // concrete capability, so tools/skills/MCP wiring lives in the host.
    const plugins = await this.options.pluginsForSession({
      sessionId: chatSessionId,
      messageId,
      settings,
      workspaceRoot,
      scope: createExecutionScope("session", undefined, { sessionId: chatSessionId }),
    });

    const session = await AgentSession.create({
      plugins,
      provider:
        this.options.providerFactory?.(settings) ?? this.buildProvider(settings),
      workspaceRoot,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
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
    if (cached) {
      // Rebuilds (settings changed) keep the conversation: copy the previous
      // session's canonical history FIRST, then release the old session —
      // dispose aborts its in-flight work, so the snapshot must not depend
      // on anything that teardown touches.
      session.history.push(
        ...cached.session.history.map((m) => ({ role: m.role, parts: [...m.parts] })),
      );
    } else if (this.options.persistDir) {
      // Fresh runtime after app restart: seed from the canonical transcript
      // codec, never from renderer/UI-coalesced session messages.
      try {
        const raw = await fs.readFile(
          path.join(this.options.persistDir, `${chatSessionId}.jsonl`),
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
    if (this.disposing.has(chatSessionId)) {
      // dispose() arrived while this build was in flight: release the
      // product in place — it must never enter the cache or run a turn.
      // (The previously cached session, if any, was already released by
      // dispose() itself.)
      await this.settleDispose(chatSessionId, session);
      throw sessionDisposedError(chatSessionId);
    }
    this.sessions.set(chatSessionId, { key, session });
    if (cached) {
      // dispose() may have released this old entry mid-build; the second
      // call is an idempotent no-op (session dispose deduplicates).
      await this.settleDispose(chatSessionId, cached.session);
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

  private forwardEvent(chatSessionId: string, messageId: string, event: HarnessEvent): void {
    const hooks = this.options.hooks;
    switch (event.type) {
      case "token":
        hooks.onDelta(chatSessionId, messageId, event.text);
        break;
      case "thinking":
        hooks.onThinking(chatSessionId, messageId, event.text);
        break;
      case "toolCall":
        hooks.onTool(chatSessionId, messageId, {
          type: "toolCall",
          id: event.id,
          toolName: event.call.toolName,
          args: event.call.args,
        });
        break;
      case "toolResult":
        hooks.onTool(chatSessionId, messageId, {
          type: "toolResult",
          toolCallId: event.toolCallId,
          content: event.content,
          isError: event.isError === true,
          durationMs: event.durationMs,
        });
        break;
      case "compaction":
        hooks.onDelta(chatSessionId, messageId, "\n\n> 🗜️ 已压缩较早的对话历史\n");
        break;
      case "error":
        hooks.onDelta(chatSessionId, messageId, `\n\n> ⚠️ ${event.message}\n`);
        break;
      default:
        break;
    }
  }

  private async persistTurn(chatSessionId: string, turnId: string, messages: Message[]): Promise<void> {
    if (!this.options.persistDir || messages.length === 0) return;
    try {
      await fs.mkdir(this.options.persistDir, { recursive: true });
      await fs.appendFile(
        path.join(this.options.persistDir, `${chatSessionId}.jsonl`),
        encodeTurnV2(turnId, new Date().toISOString(), messages),
        "utf8",
      );
    } catch (err) {
      this.options.hooks.log("warn", "persist failed", String(err));
    }
  }
}
