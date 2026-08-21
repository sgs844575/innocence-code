// Canonical, provider-agnostic message model. Providers translate this to
// their own wire formats; the kernel only ever sees these types.

/** Loose alias for JSON Schema objects supplied by tools. */
export interface JsonSchema {
  [key: string]: unknown;
}

export interface TextPart {
  type: "text";
  text: string;
}

/** 推理/思考增量（DeepSeek reasoning_content、Anthropic thinking 等）。 */
export interface ThinkingPart {
  type: "thinking";
  text: string;
}

export interface ToolCallPart {
  type: "toolCall";
  id: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolResultPart {
  type: "toolResult";
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export type MessagePart = TextPart | ThinkingPart | ToolCallPart | ToolResultPart;

export type MessageRole = "user" | "assistant";

export interface Message {
  role: MessageRole;
  parts: MessagePart[];
}
