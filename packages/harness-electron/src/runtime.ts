import fs from "node:fs/promises";
import path from "node:path";
import {
  AgentSession,
  type HarnessEvent,
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
import { fsPlugin } from "@innocencecode/tools-fs";
import { shellPlugin } from "@innocencecode/tools-shell";
import { subagentPlugin } from "@innocencecode/plugin-subagent";
import { skillsPlugin } from "@innocencecode/plugin-skills";
import { mcpPlugin } from "@innocencecode/plugin-mcp";
import { loadInnocenceConfig } from "@innocencecode/harness-core";
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
      ask: async (request) => {
        const ask: PermissionAsk = { requestId: nextId("perm"), call: request };
        const answer = await this.options.hooks.askPermission(chatSessionId, messageId, ask);
        return answer;
      },
    };

    // Project config (.innocence/config.json): permission rules + MCP servers.
    const projectConfig = await loadInnocenceConfig(
      settings.workspaceRoot || process.cwd(),
    );

    const session = await AgentSession.create({
      plugins: [
        fsPlugin,
        shellPlugin,
        subagentPlugin,
        skillsPlugin({
          dirs: [path.join(settings.workspaceRoot || process.cwd(), ".innocence", "skills")],
        }),
        mcpPlugin({ servers: projectConfig.mcpServers ?? {} }),
      ],
      provider:
        this.options.providerFactory?.(settings) ?? this.buildProvider(settings),
      workspaceRoot: settings.workspaceRoot || process.cwd(),
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      permission: {
        mode: settings.permissionMode,
        decider,
        projectConfig: projectConfig.permissions,
      },
      logger: (level, msg, data) => this.options.hooks.log(level, msg, data),
    });
    // Rebuilds (settings changed) keep the conversation: copy the previous
    // session's history so switching providers mid-chat is not destructive.
    if (cached) {
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
