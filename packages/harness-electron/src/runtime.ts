import fs from "node:fs/promises";
import path from "node:path";
import {
  AgentSession,
  type HarnessEvent,
  type Message,
  type PermissionDecider,
  type Provider,
  type ToolCallInfo,
} from "@innocencecode/harness-core";
import { createMockProvider } from "@innocencecode/provider-mock";
import { createOpenAIProvider } from "@innocencecode/provider-openai";
import { createAnthropicProvider } from "@innocencecode/provider-anthropic";
import { fsPlugin } from "@innocencecode/tools-fs";
import {
  DEFAULT_SYSTEM_PROMPT,
  MOCK_GREETING,
  type HarnessSettings,
} from "./settings";

export type AskResponse = "allow" | "allowSession" | "deny";

export interface PermissionAsk {
  requestId: string;
  call: ToolCallInfo;
}

/** Hooks the host implements to bridge UI, storage and dialogs. */
export interface RuntimeHooks {
  /** Text delta for the streaming assistant message. */
  onDelta(sessionId: string, messageId: string, delta: string): void;
  onCompleted(sessionId: string, messageId: string): void;
  onError(sessionId: string, messageId: string, error: string): void;
  /** Ask the user about a tool call; resolves with their choice. */
  askPermission(sessionId: string, messageId: string, ask: PermissionAsk): Promise<AskResponse>;
  log(level: "info" | "warn" | "error", msg: string, data?: unknown): void;
}

export interface RuntimeOptions {
  settings(): HarnessSettings;
  hooks: RuntimeHooks;
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
 * is surfaced as blockquote lines inside the same markdown stream (M3
 * simplification until a proper activity feed lands).
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
      await this.persist(chatSessionId, text, agent.history);
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

  /** Drops cached agent state (e.g. when the chat session is deleted). */
  dispose(chatSessionId: string): void {
    this.sessions.delete(chatSessionId);
  }

  private async agentFor(
    chatSessionId: string,
    messageId: string,
  ): Promise<AgentSession> {
    const settings = this.options.settings();
    const key = JSON.stringify(settings);
    const cached = this.sessions.get(chatSessionId);
    if (cached && cached.key === key) return cached.session;

    const decider: PermissionDecider = {
      ask: async (call) => {
        const ask: PermissionAsk = { requestId: nextId("perm"), call };
        const answer = await this.options.hooks.askPermission(chatSessionId, messageId, ask);
        return answer;
      },
    };

    const session = await AgentSession.create({
      plugins: [fsPlugin],
      provider:
        this.options.providerFactory?.(settings) ?? this.buildProvider(settings),
      workspaceRoot: settings.workspaceRoot || process.cwd(),
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      permission: {
        mode: settings.permissionMode,
        decider,
        projectConfig: undefined, // loaded by host later from .innocence/config.json
      },
      logger: (level, msg, data) => this.options.hooks.log(level, msg, data),
    });
    // Rebuilds (settings changed) keep the conversation: copy the previous
    // session's history so switching providers mid-chat is not destructive.
    if (cached) {
      session.history.push(
        ...cached.session.history.map((m) => ({ role: m.role, parts: [...m.parts] })),
      );
    }
    this.sessions.set(chatSessionId, { key, session });
    return session;
  }

  private buildProvider(settings: HarnessSettings) {
    switch (settings.providerId) {
      case "openai":
        return createOpenAIProvider({
          apiKey: settings.openai.apiKey || undefined,
          baseURL: settings.openai.baseURL || undefined,
          model: settings.openai.model,
        });
      case "anthropic":
        return createAnthropicProvider({
          apiKey: settings.anthropic.apiKey || undefined,
          model: settings.anthropic.model,
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
      case "toolCall": {
        const args = JSON.stringify(event.call.args);
        hooks.onDelta(
          chatSessionId,
          messageId,
          `\n\n> 🔧 **${event.call.toolName}** \`${shorten(args, 200)}\`\n`,
        );
        break;
      }
      case "toolResult": {
        const icon = event.isError ? "❌" : "✅";
        hooks.onDelta(
          chatSessionId,
          messageId,
          `> ${icon} ${shorten(event.content.replace(/\n/g, " "), 160)} (${event.durationMs}ms)\n`,
        );
        break;
      }
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

  private async persist(chatSessionId: string, userText: string, history: Message[]): Promise<void> {
    if (!this.options.persistDir) return;
    try {
      await fs.mkdir(this.options.persistDir, { recursive: true });
      const record = {
        at: new Date().toISOString(),
        type: "turn",
        user: userText,
        history: history.map((m) => ({ role: m.role, parts: m.parts })),
      };
      await fs.appendFile(
        path.join(this.options.persistDir, `${chatSessionId}.jsonl`),
        `${JSON.stringify(record)}\n`,
        "utf8",
      );
    } catch (err) {
      this.options.hooks.log("warn", "persist failed", String(err));
    }
  }
}

function shorten(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
