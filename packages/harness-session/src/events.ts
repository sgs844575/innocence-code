import type { MessagePart } from "./types";
import type { PermissionResolution } from "@innocencecode/harness-permissions";
import type { PermissionResource, ToolCallInfo } from "@innocencecode/harness-permissions";
import type { ToolOutcome } from "@innocencecode/harness-tools";

export type HarnessEvent =
  | { type: "turnStart"; turn: number }
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "assistantMessage"; parts: MessagePart[] }
  | {
      type: "toolCall";
      id: string;
      call: ToolCallInfo;
      /** Per-invocation id (ctx.scope.invocationId) for event correlation. */
      invocationId?: string;
    }
  | {
      type: "permission";
      id: string;
      toolName: string;
      resolution: PermissionResolution;
    }
  | {
      type: "toolResult";
      toolCallId: string;
      content: string;
      isError?: boolean;
      durationMs: number;
      /** Per-invocation id; matches the toolCall event of the same invocation. */
      invocationId?: string;
      /** Canonical permission resource this invocation acted on. */
      resource?: PermissionResource;
      /** Standardized terminal outcome of the invocation. */
      outcome?: ToolOutcome;
    }
  | { type: "compaction"; removedMessages: number }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "done"; turns: number };

export type HarnessEventListener = (event: HarnessEvent) => void;
