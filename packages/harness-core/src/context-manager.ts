// Shim: compaction (ContextManager) lives in the session spine.
export {
  ContextManager,
  DEFAULT_COMPACTION,
  SUMMARIZE_SYSTEM_PROMPT,
  estimateTokens,
  findSplitIndex,
  type CompactionOptions,
} from "@innocencecode/harness-session";
