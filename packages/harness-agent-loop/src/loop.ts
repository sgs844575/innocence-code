import { ContextManager } from "@innocencecode/harness-session";
import { createExecutionScope, type ExecutionScopeIdentity } from "@innocencecode/harness-tools";
import type { HarnessEventListener } from "@innocencecode/harness-session";
import { PermissionEngine } from "@innocencecode/harness-permissions";
import type { PermissionRequest, PermissionResource } from "@innocencecode/harness-permissions";
import type { Provider } from "@innocencecode/harness-providers";
import {
  executeToolInvocation,
  isAbortError,
  toolErrorOutcome,
  type ToolOutcome,
} from "@innocencecode/harness-tools";
import type { Message, MessagePart, ToolCallPart, ToolResultPart } from "@innocencecode/harness-session";
import type { Tool, ToolContext, ToolsService } from "@innocencecode/harness-tools";
import { bindSubagentSpawner, type SubagentSpawner } from "@innocencecode/harness-agent";

export interface LoopOptions {
  provider: Provider;
  tools: ToolsService;
  permission: PermissionEngine;
  systemPrompt: string;
  workspaceRoot: string;
  onEvent: HarnessEventListener;
  compactor?: ContextManager;
  signal?: AbortSignal;
  maxTurns?: number;
  toolTimeoutMs?: number;
  /** Extra wait after the timeout abort before a tool is declared unstable. */
  abortGraceMs?: number;
  spawner?: SubagentSpawner;
  /**
   * Run-level identity inherited by every per-invocation scope minted in this
   * loop (sessionId/routeId/taskId/parentInvocationId). Subagent children run
   * with the parent's identity plus the spawning invocation's id.
   */
  scope?: ExecutionScopeIdentity;
}

export interface LoopResult {
  turns: number;
  /** Text of the final assistant message (empty when aborted early). */
  finalText: string;
  aborted: boolean;
}

export const DEFAULT_MAX_TURNS = 40;
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/**
 * The synchronous, readable agent loop: stream a model turn, gate every tool
 * call through the permission engine, feed results back, repeat until the
 * model answers without tool calls. The input is the canonical user message
 * (already skill-expanded and processor-run by the session); tool-result user
 * turns pushed by the loop itself never pass through processors.
 */
export async function runLoop(
  history: Message[],
  input: Message,
  opts: LoopOptions,
): Promise<LoopResult> {
  const {
    provider,
    tools,
    permission,
    systemPrompt,
    workspaceRoot,
    onEvent,
    compactor,
    signal,
  } = opts;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  // Shallow copy: history owns its entries even when the caller reuses the
  // canonical Message object it passed in.
  history.push({ role: input.role, parts: [...input.parts] });

  const baseToolCtx = {
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
        tools: tools.specs(),
        signal,
      })) {
        if (delta.type === "text") {
          if (delta.text) {
            parts.push({ type: "text", text: delta.text });
            onEvent({ type: "token", text: delta.text });
          }
        } else if (delta.type === "thinking") {
          if (delta.text) {
            parts.push({ type: "thinking", text: delta.text });
            onEvent({ type: "thinking", text: delta.text });
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

      const calls = parts.filter(
        (p): p is ToolCallPart => p.type === "toolCall",
      );

      /**
       * Per-call preparation, in the fixed executor-chain order:
       *   raw → validateArgs(raw) → permissionResource(raw) → persistArgs(raw)
       * persistArgs runs exactly ONCE per invocation; its output is the only
       * args shape allowed into history/events/permission/audit. Raw values
       * live only for this invocation and die with it.
       */
      interface PreparedCall {
        part: ToolCallPart;
        tool?: Tool;
        ctx?: ToolContext;
        resource?: PermissionResource;
        persistedArgs: Record<string, unknown>;
        failure?: string;
      }
      const prepared = new Map<string, PreparedCall>();
      for (const part of calls) {
        const tool = tools.get(part.toolName);
        if (!tool) {
          prepared.set(part.id, { part, tool: undefined, persistedArgs: {} });
          continue;
        }
        // Fresh scope per invocation — never a session-level reused one —
        // inheriting the run identity. The spawner handed to this invocation
        // is bound to the same scope so subagent children inherit it.
        const scope = createExecutionScope(tool.name, undefined, opts.scope);
        const invocationCtx: ToolContext = {
          ...baseToolCtx,
          scope,
          subagent: opts.spawner ? bindSubagentSpawner(opts.spawner, scope) : undefined,
        };
        try {
          await tool.validateArgs?.(part.args);
          const resource = await tool.permissionResource(part.args, invocationCtx);
          const persistedArgs = tool.persistArgs(part.args);
          prepared.set(part.id, { part, tool, ctx: invocationCtx, resource, persistedArgs });
        } catch (err) {
          prepared.set(part.id, {
            part,
            tool,
            ctx: invocationCtx,
            persistedArgs: {},
            failure: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Persisted assistant message: secrets from raw args never enter history.
      const toPersisted = (p: MessagePart): MessagePart =>
        p.type === "toolCall"
          ? { ...p, args: prepared.get(p.id)?.persistedArgs ?? {} }
          : p;
      history.push({ role: "assistant", parts: mergeTextParts(parts).map(toPersisted) });
      onEvent({ type: "assistantMessage", parts: parts.map(toPersisted) });

      if (calls.length === 0) break;

      const resultParts: ToolResultPart[] = [];
      for (const part of calls) {
        const item = prepared.get(part.id)!;
        const started = Date.now();
        const invocationId = item.ctx?.scope.invocationId;
        const finish = (content: string, isError: boolean, outcome: ToolOutcome) => {
          resultParts.push({
            type: "toolResult",
            toolCallId: part.id,
            content,
            isError: isError || undefined,
          });
          onEvent({
            type: "toolResult",
            toolCallId: part.id,
            content,
            isError: isError || undefined,
            durationMs: Date.now() - started,
            invocationId,
            resource: item.resource,
            outcome,
          });
        };
        const failClosed = (content: string) => finish(content, true, "error");

        onEvent({
          type: "toolCall",
          id: part.id,
          call: { toolName: part.toolName, args: item.persistedArgs },
          invocationId,
        });

        // Stopped mid-turn: fail the remaining calls closed without touching
        // the permission chain — a stopped run must never prompt again. The
        // outcome is "aborted" (same rule as M3): user-stop terminations must
        // not inflate tool error rates in outcome-aggregating hosts.
        if (signal?.aborted) {
          finish("运行已中止", true, "aborted");
          continue;
        }

        if (!item.tool) {
          failClosed(`未知工具：${part.toolName}`);
          continue;
        }
        if (item.failure !== undefined) {
          failClosed(`工具调用准备失败：${item.failure}`);
          continue;
        }

        const request: PermissionRequest = {
          toolName: item.tool.name,
          resource: item.resource!,
          args: item.persistedArgs,
        };
        let resolution;
        try {
          resolution = await permission.resolve(request, {
            readOnly: item.tool.readOnly,
            sideEffect: item.tool.sideEffect,
          });
        } catch (err) {
          // validateResource rejected the resource (audited inside resolve): fail closed.
          failClosed(
            `资源校验未通过：${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        onEvent({
          type: "permission",
          id: part.id,
          toolName: part.toolName,
          resolution,
        });

        if (resolution.decision === "deny") {
          failClosed(`权限被拒绝：${resolution.reason}`);
          continue;
        }

        // Permission granted: hand the invocation to the executor, which owns
        // the derived AbortController, middleware chain, real abort-on-timeout
        // and outcome standardization. Raw args stay in this closure and die
        // with it.
        try {
          const result = await executeToolInvocation(
            {
              toolName: item.tool.name,
              persistedArgs: item.persistedArgs,
              ctx: item.ctx!,
              parentSignal: signal,
            },
            tools.middlewares(),
            {
              timeoutMs: toolTimeoutMs,
              abortGraceMs: opts.abortGraceMs,
              execute: (_signal, ctx) => item.tool!.execute(part.args, ctx),
            },
          );
          finish(
            result.content,
            result.isError === true,
            result.isError === true ? "error" : "success",
          );
        } catch (err) {
          // Tool failures feed back to the model instead of killing the loop.
          // With the run stopped, any failure shape counts as aborted.
          const outcome = toolErrorOutcome(err, { parentAborted: signal?.aborted === true });
          const detail = err instanceof Error ? err.message : String(err);
          finish(
            outcome === "aborted" ? `工具执行已中止：${detail}` : `工具执行出错：${detail}`,
            true,
            outcome,
          );
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

  // A mid-tool stop surfaces as aborted tool results that never throw: the
  // loop flag must reflect the signal at exit, not just thrown abort errors.
  if (signal?.aborted) aborted = true;

  const last = [...history].reverse().find((m) => m.role === "assistant");
  const finalText =
    last?.parts.filter((p) => p.type === "text").map((p) => p.text).join("") ?? "";
  onEvent({ type: "done", turns });
  return { turns, finalText, aborted };
}

/** Collapses consecutive text deltas into one part (readable history, clean transcripts). */
function mergeTextParts(parts: MessagePart[]): MessagePart[] {
  const merged: MessagePart[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (part.type === "text" && last?.type === "text") {
      last.text += part.text;
    } else if (part.type === "thinking" && last?.type === "thinking") {
      last.text += part.text;
    } else {
      merged.push(part);
    }
  }
  return merged;
}
