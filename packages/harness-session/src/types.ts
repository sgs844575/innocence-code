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

export function textMessage(role: MessageRole, text: string): Message {
  return { role, parts: [{ type: "text", text }] };
}

/** True when a message carries no tool call/result parts (safe compaction boundary). */
export function isPlainText(message: Message): boolean {
  return (
    message.role === "user" &&
    message.parts.length > 0 &&
    message.parts.every((p) => p.type === "text")
  );
}

export function messageText(message: Message): string {
  return message.parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Serialize a message list to a readable transcript (used for compaction summaries). */
export function toTranscript(messages: Message[]): string {
  return messages
    .map((m) => {
      const who = m.role === "user" ? "用户" : "助手";
      const body = m.parts
        .map((p) => {
          switch (p.type) {
            case "text":
              return p.text;
            case "thinking":
              return `[思考] ${p.text.slice(0, 400)}`;
            case "toolCall":
              return `[调用工具 ${p.toolName}，参数 ${JSON.stringify(p.args)}]`;
            case "toolResult":
              return `[工具结果${p.isError ? "（出错）" : ""}：${p.content.slice(0, 400)}]`;
          }
        })
        .join("\n");
      return `${who}：${body}`;
    })
    .join("\n\n");
}
