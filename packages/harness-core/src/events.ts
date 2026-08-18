import type { MessagePart } from "./types";
import type { PermissionResolution } from "./permission";
import type { ToolCallInfo } from "./policy";

export type HarnessEvent =
  | { type: "turnStart"; turn: number }
  | { type: "token"; text: string }
  | { type: "assistantMessage"; parts: MessagePart[] }
  | { type: "toolCall"; id: string; call: ToolCallInfo }
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
    }
  | { type: "compaction"; removedMessages: number }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "done"; turns: number };

export type HarnessEventListener = (event: HarnessEvent) => void;
