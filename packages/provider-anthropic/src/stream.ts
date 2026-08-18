import type { Delta } from "@innocencecode/harness-core";

interface ToolAccumulator {
  id: string;
  name: string;
  json: string;
}

/**
 * Turns SSE `data:` payload strings into harness deltas. Text deltas stream
 * immediately; tool_use blocks accumulate `input_json_delta` fragments until
 * their content_block_stop, and are emitted complete after the stream ends.
 */
export async function* anthropicDeltasFromDataLines(
  lines: AsyncIterable<string>,
): AsyncGenerator<Delta> {
  const tools: ToolAccumulator[] = [];
  let current: ToolAccumulator | null = null;
  // message_delta only repeats output_tokens; carry the message_start count.
  let lastInputTokens = 0;

  for await (const line of lines) {
    if (!line) continue;
    let evt: AnthropicEvent;
    try {
      evt = JSON.parse(line) as AnthropicEvent;
    } catch {
      continue;
    }
    switch (evt.type) {
      case "error":
        throw new Error(
          `Anthropic 流错误：${evt.error?.message ?? JSON.stringify(evt.error)}`,
        );
      case "message_start":
        if (evt.message?.usage) {
          lastInputTokens = evt.message.usage.input_tokens ?? lastInputTokens;
          yield {
            type: "usage",
            inputTokens: lastInputTokens,
            outputTokens: 0,
          };
        }
        break;
      case "content_block_start":
        if (evt.content_block?.type === "tool_use") {
          current = {
            id: evt.content_block.id ?? "",
            name: evt.content_block.name ?? "",
            json: "",
          };
        }
        break;
      case "content_block_delta": {
        const delta = evt.delta;
        if (delta?.type === "text_delta" && delta.text) {
          yield { type: "text", text: delta.text };
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          // 扩展思考增量（thinking budget 开启时）
          yield { type: "thinking", text: delta.thinking };
        } else if (delta?.type === "input_json_delta" && current) {
          current.json += delta.partial_json ?? "";
        }
        break;
      }
      case "content_block_stop":
        if (current) {
          tools.push(current);
          current = null;
        }
        break;
      case "message_delta":
        if (evt.usage) {
          yield {
            type: "usage",
            inputTokens: evt.usage.input_tokens ?? lastInputTokens,
            outputTokens: evt.usage.output_tokens ?? 0,
          };
        }
        break;
      default:
        break; // message_stop etc. — nothing to yield
    }
  }

  for (const [i, t] of tools.entries()) {
    if (!t.name) continue;
    yield {
      type: "toolCall",
      id: t.id || `call_${i + 1}`,
      toolName: t.name,
      args: parseInput(t.json),
    };
  }
}

function parseInput(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { __unparsed: raw };
  }
}

interface AnthropicEvent {
  type?: string;
  error?: { message?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string };
  delta?:
    | { type: "text_delta"; text?: string }
    | { type: "thinking_delta"; thinking?: string }
    | { type: "input_json_delta"; partial_json?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
}
