import { ContextManager } from "./context-manager";
import type { HarnessEventListener } from "./events";
import { PermissionEngine } from "./permission";
import type { PluginRegistry } from "./registry";
import type { Provider } from "./provider";
import { textMessage, type Message, type MessagePart, type ToolResultPart } from "./types";
import type { ToolContext } from "./tool";

export interface LoopOptions {
  provider: Provider;
  registry: PluginRegistry;
  permission: PermissionEngine;
  systemPrompt: string;
  workspaceRoot: string;
  onEvent: HarnessEventListener;
  compactor?: ContextManager;
  signal?: AbortSignal;
  maxTurns?: number;
  toolTimeoutMs?: number;
}

export interface LoopResult {
  turns: number;
  /** Text of the final assistant message (empty when aborted early). */
  finalText: string;
  aborted: boolean;
}

export const DEFAULT_MAX_TURNS = 40;
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError")
  );
}

/**
 * The synchronous, readable agent loop: stream a model turn, gate every tool
 * call through the permission engine, feed results back, repeat until the
 * model answers without tool calls.
 */
export async function runLoop(
  history: Message[],
  userText: string,
  opts: LoopOptions,
): Promise<LoopResult> {
  const {
    provider,
    registry,
    permission,
    systemPrompt,
    workspaceRoot,
    onEvent,
    compactor,
    signal,
  } = opts;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  history.push(textMessage("user", userText));

  const toolCtx: ToolContext = {
    workspaceRoot,
    signal: signal ?? new AbortController().signal,
    log: () => {}, // session installs a real logger over onEvent
  };

  let aborted = false;
  let turns = 0;

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (signal?.aborted) break;
      turns = turn;
      onEvent({ type: "turnStart", turn });

      if (compactor) {
        const compacted = await compactor.maybeCompact(history, provider, signal);
        if (compacted) onEvent({ type: "compaction", removedMessages: history.length });
      }

      const parts: MessagePart[] = [];
      for await (const delta of provider.chat({
        system: systemPrompt,
        messages: history,
        tools: registry.toolSpecs(),
        signal,
      })) {
        if (delta.type === "text") {
          if (delta.text) {
            parts.push({ type: "text", text: delta.text });
            onEvent({ type: "token", text: delta.text });
          }
        } else if (delta.type === "toolCall") {
          parts.push({
            type: "toolCall",
            id: delta.id,
            toolName: delta.toolName,
            args: delta.args,
          });
        }
        // usage deltas are informational; providers accumulate their own accounting.
      }

      if (parts.length === 0) break;
      history.push({ role: "assistant", parts });
      onEvent({ type: "assistantMessage", parts });

      const calls = parts.filter(
        (p): p is Extract<MessagePart, { type: "toolCall" }> => p.type === "toolCall",
      );
      if (calls.length === 0) break;

      const resultParts: ToolResultPart[] = [];
      for (const call of calls) {
        onEvent({
          type: "toolCall",
          id: call.id,
          call: { toolName: call.toolName, args: call.args },
        });

        const tool = registry.tools.get(call.toolName);
        if (!tool) {
          resultParts.push({
            type: "toolResult",
            toolCallId: call.id,
            content: `未知工具：${call.toolName}`,
            isError: true,
          });
          onEvent({
            type: "toolResult",
            toolCallId: call.id,
            content: `未知工具：${call.toolName}`,
            isError: true,
            durationMs: 0,
          });
          continue;
        }

        const resolution = await permission.resolve(
          { toolName: call.toolName, args: call.args },
          { readOnly: tool.readOnly },
        );
        onEvent({
          type: "permission",
          id: call.id,
          toolName: call.toolName,
          resolution,
        });

        const started = Date.now();
        if (resolution.decision === "deny") {
          const content = `权限被拒绝：${resolution.reason}`;
          resultParts.push({
            type: "toolResult",
            toolCallId: call.id,
            content,
            isError: true,
          });
          onEvent({
            type: "toolResult",
            toolCallId: call.id,
            content,
            isError: true,
            durationMs: 0,
          });
          continue;
        }

        try {
          const result = await withTimeout(
            tool.execute(call.args, toolCtx),
            toolTimeoutMs,
            toolCtx.signal,
          );
          resultParts.push({
            type: "toolResult",
            toolCallId: call.id,
            content: result.content,
            isError: result.isError,
          });
          onEvent({
            type: "toolResult",
            toolCallId: call.id,
            content: result.content,
            isError: result.isError,
            durationMs: Date.now() - started,
          });
        } catch (err) {
          // Tool failures feed back to the model instead of killing the loop.
          const content = `工具执行出错：${err instanceof Error ? err.message : String(err)}`;
          resultParts.push({
            type: "toolResult",
            toolCallId: call.id,
            content,
            isError: true,
          });
          onEvent({
            type: "toolResult",
            toolCallId: call.id,
            content,
            isError: true,
            durationMs: Date.now() - started,
          });
        }
      }
      history.push({ role: "user", parts: resultParts });
    }
  } catch (err) {
    if (isAbortError(err)) {
      aborted = true;
    } else {
      onEvent({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        fatal: true,
      });
    }
  }

  const last = [...history].reverse().find((m) => m.role === "assistant");
  const finalText =
    last?.parts.filter((p) => p.type === "text").map((p) => p.text).join("") ?? "";
  onEvent({ type: "done", turns });
  return { turns, finalText, aborted };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`工具执行超时（>${Math.round(timeoutMs / 1000)}s）`)),
          timeoutMs,
        );
      }),
      ...(signal
        ? [
            new Promise<never>((_, reject) => {
              if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
              else signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
            }),
          ]
        : []),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
