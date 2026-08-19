import type { JsonSchema, Message } from "./types";

/** Tool description sent to the model (JSON Schema for parameters). */
export interface ToolSpec {
  name: string;
  description: string;
  /** Informational for the model; permission engine uses the Tool's flag. */
  readOnly?: boolean;
  parameters: JsonSchema;
}

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  /** Model identifier; providers may override with their own configured default. */
  model?: string;
  signal?: AbortSignal;
}

/**
 * A provider streams deltas for one model turn. Tool calls arrive complete —
 * incremental aggregation is the provider's internal concern.
 */
export type Delta =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "toolCall";
      id: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | { type: "usage"; inputTokens: number; outputTokens: number };

export interface Provider {
  /** Stable identifier, e.g. "openai", "anthropic", "mock". */
  id: string;
  capabilities?: Readonly<Record<string, boolean | "unknown">>;
  chat(req: ChatRequest): AsyncIterable<Delta>;
}
