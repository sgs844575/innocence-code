export type {
  JsonSchema,
  Message,
  MessagePart,
  MessageRole,
  TextPart,
  ThinkingPart,
  ToolCallPart,
  ToolResultPart,
} from "./types";
export { textMessage, isPlainText, messageText, toTranscript } from "./types";
export type { ChatRequest, Delta, Provider, ToolSpec } from "@innocencecode/harness-providers";
export {
  processMessage,
  type MessageProcessor,
  type MessageProcessorContext,
} from "./processor";
export type { HarnessEvent, HarnessEventListener } from "./events";
export {
  ContextManager,
  DEFAULT_COMPACTION,
  SUMMARIZE_SYSTEM_PROMPT,
  estimateTokens,
  findSplitIndex,
  type CompactionOptions,
} from "./context-manager";
export {
  createSessionPlugin,
  type SessionPlugin,
  type SessionPluginOptions,
  type SessionService,
} from "./service";
