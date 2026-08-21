// Shim: message model lives in the session spine; JsonSchema in the tools
// spine (single source after the T6 type convergence).
export type { JsonSchema } from "@innocencecode/harness-tools";
export type {
  Message,
  MessagePart,
  MessageRole,
  TextPart,
  ThinkingPart,
  ToolCallPart,
  ToolResultPart,
} from "@innocencecode/harness-session";
export { textMessage, isPlainText, messageText, toTranscript } from "@innocencecode/harness-session";
