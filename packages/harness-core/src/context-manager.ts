import type { Provider } from "./provider";
import { isPlainText, toTranscript, type Message } from "./types";

export const SUMMARIZE_SYSTEM_PROMPT =
  "你是对话压缩器。把下面的对话历史总结成一份简洁但信息完整的摘要，" +
  "保留：任务目标、已做过的决定、已完成的工具操作及其结果要点、尚未完成的事项。" +
  "直接输出摘要正文，不要任何开场白。";

export interface CompactionOptions {
  /** Token estimate above this triggers compaction. Default 48000. */
  maxContextTokens: number;
  /** Recent messages always kept verbatim. Default 6. */
  keepRecent: number;
}

export const DEFAULT_COMPACTION: CompactionOptions = {
  maxContextTokens: 48_000,
  keepRecent: 6,
};

/** Rough token estimate (~4 chars per token) over the serialized message list. */
export function estimateTokens(messages: Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/**
 * Chooses the split index: everything before it may be compacted, the tail is
 * kept verbatim. The split must land on a plain user text message so that
 * toolCall/toolResult pairing is never broken. Returns 0 when no safe split
 * exists (history too short).
 */
export function findSplitIndex(messages: Message[], keepRecent: number): number {
  const maxSplit = messages.length - keepRecent;
  for (let i = maxSplit; i > 0; i--) {
    if (isPlainText(messages[i])) return i;
  }
  return 0;
}

export class ContextManager {
  readonly options: CompactionOptions;

  constructor(options: Partial<CompactionOptions> = {}) {
    this.options = { ...DEFAULT_COMPACTION, ...options };
  }

  needsCompaction(messages: Message[]): boolean {
    return estimateTokens(messages) > this.options.maxContextTokens;
  }

  /**
   * Compacts history in place when over threshold. Returns true when a
   * compaction happened. When under threshold (or no safe split), no-op.
   */
  async maybeCompact(
    messages: Message[],
    provider: Provider,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.needsCompaction(messages)) return false;
    const split = findSplitIndex(messages, this.options.keepRecent);
    if (split <= 0) return false;

    const oldMessages = messages.slice(0, split);
    const transcript = toTranscript(oldMessages);
    let summary = "";
    for await (const delta of provider.chat({
      system: SUMMARIZE_SYSTEM_PROMPT,
      messages: [{ role: "user", parts: [{ type: "text", text: transcript }] }],
      tools: [],
      signal,
    })) {
      if (delta.type === "text") summary += delta.text;
    }
    if (!summary.trim()) return false;

    const summaryMessage: Message = {
      role: "user",
      parts: [
        {
          type: "text",
          text: `[此前对话已压缩为摘要]\n${summary}`,
        },
      ],
    };
    const tail = messages.slice(split);
    messages.length = 0;
    messages.push(summaryMessage, ...tail);
    return true;
  }
}
