// Harness-event → host-hook translation (split from runtime.ts by
// responsibility): maps one AgentSession event onto the streaming UI hooks
// (text deltas, thinking, structured tool parts, compaction/error notices).
import type { HarnessEvent } from "@innocencecode/harness-core";
import type { RuntimeHooks } from "./runtime-types";

export function forwardHarnessEvent(
  hooks: RuntimeHooks,
  sessionId: string,
  messageId: string,
  event: HarnessEvent,
): void {
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
