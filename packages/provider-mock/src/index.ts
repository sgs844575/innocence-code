import type { Context } from "@innocencecode/kernel";
import {
  SUMMARIZE_SYSTEM_PROMPT,
  type ChatRequest,
  type Delta,
  type Provider,
} from "@innocencecode/harness-core";

export interface MockToolCall {
  toolName: string;
  args?: Record<string, unknown>;
}

/** One scripted model turn: some text and/or some tool calls. */
export interface MockTurn {
  text?: string;
  toolCalls?: MockToolCall[];
}

export interface MockProviderOptions {
  id?: string;
  turns: MockTurn[];
  /** Characters per text delta. Default 4. */
  chunkSize?: number;
  /** Delay between text chunks (ms). Default 0. */
  delayMs?: number;
  /** Response used for compaction-summary requests so scripts stay linear. */
  summarizeResponse?: string;
  /** Final text once the script is exhausted. */
  exhaustedText?: string;
  /** Observes every chat request (for assertions). */
  onChat?: (req: ChatRequest) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createMockProvider(opts: MockProviderOptions): Provider {
  const {
    turns,
    chunkSize = 4,
    delayMs = 0,
    summarizeResponse = "[mock 摘要：此前对话已完成压缩测试]",
    exhaustedText = "[mock] 剧本已播完。",
  } = opts;
  let cursor = 0;
  let callSeq = 0;

  return {
    id: opts.id ?? "mock",

    async *chat(req: ChatRequest): AsyncIterable<Delta> {
      opts.onChat?.(req);

      // Compaction summary requests bypass the script so the main loop
      // script stays a simple linear sequence.
      if (req.system === SUMMARIZE_SYSTEM_PROMPT) {
        for (let i = 0; i < summarizeResponse.length; i += chunkSize) {
          yield { type: "text", text: summarizeResponse.slice(i, i + chunkSize) };
        }
        return;
      }

      const turn = cursor < turns.length ? turns[cursor] : undefined;
      cursor += 1;

      const text = turn?.text ?? (cursor > turns.length ? exhaustedText : undefined);
      if (text) {
        for (let i = 0; i < text.length; i += chunkSize) {
          if (delayMs) await sleep(delayMs);
          yield { type: "text", text: text.slice(i, i + chunkSize) };
        }
      }
      for (const call of turn?.toolCalls ?? []) {
        callSeq += 1;
        yield {
          type: "toolCall",
          id: `call_${callSeq}`,
          toolName: call.toolName,
          args: call.args ?? {},
        };
      }
    },
  };
}

/** Kernel-native mock provider plugin (name "provider-mock"). */
export interface MockPlugin {
  readonly name: "provider-mock";
  apply(ctx: Context): void;
}

/** Registers the scripted mock provider on the spine providers service. */
export function createMockPlugin(options: MockProviderOptions): MockPlugin {
  return {
    name: "provider-mock",
    apply(ctx) {
      ctx.providers.register(createMockProvider(options));
    },
  };
}
