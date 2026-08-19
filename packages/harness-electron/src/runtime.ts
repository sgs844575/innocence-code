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
 * Owns one AgentSession per chat session, rebuilt when settings change, and
 * translates harness events into the host's streaming UI hooks. Tool activity
 * is forwarded as structured parts via onTool (paired by id/toolCallId).
 */
export class HarnessRuntime {
  private readonly options: RuntimeOptions;
  private readonly sessions = new Map<string, { key: string; session: AgentSession }>();
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
   */
  async dispose(chatSessionId: string): Promise<void> {
    const cached = this.sessions.get(chatSessionId);
    if (!cached) return;
    this.sessions.delete(chatSessionId);
    await this.settleDispose(chatSessionId, cached.session);
  }

  /** Releases every cached agent session (e.g. app shutdown). */
  async disposeAll(): Promise<void> {
    const entries = [...this.sessions];
    this.sessions.clear();
    await Promise.all(
      entries.map(([chatSessionId, entry]) => this.settleDispose(chatSessionId, entry.session)),
    );
  }

  private async settleDispose(chatSessionId: string, session: AgentSession): Promise<void> {
    try {
      await session.dispose();
    } catch (err) {
      this.options.hooks.log("error", "session dispose failed", `${chatSessionId}: ${String(err)}`);
    }
  }

  private async agentFor(
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
    this.sessions.set(chatSessionId, { key, session });
    if (cached) {
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
