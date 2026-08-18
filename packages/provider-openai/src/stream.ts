import type { Delta } from "@innocencecode/harness-core";

interface ToolAccumulator {
  id: string;
  name: string;
  args: string;
}

/**
 * Turns SSE `data:` payload strings (already stripped of the prefix) into
 * harness deltas. Text streams immediately; tool calls are aggregated across
 * their argument fragments and emitted complete when the stream ends.
 */
export async function* openAIDeltasFromDataLines(
  lines: AsyncIterable<string>,
): AsyncGenerator<Delta> {
  const toolAcc = new Map<number, ToolAccumulator>();

  for await (const line of lines) {
    if (!line || line === "[DONE]") continue;
    let evt: OpenAIChunk;
    try {
      evt = JSON.parse(line) as OpenAIChunk;
    } catch {
      continue; // tolerate keep-alive noise
    }
    if (evt.error) {
      throw new Error(`OpenAI 流错误：${evt.error.message ?? JSON.stringify(evt.error)}`);
    }
    if (evt.usage) {
      yield {
        type: "usage",
        inputTokens: evt.usage.prompt_tokens ?? 0,
        outputTokens: evt.usage.completion_tokens ?? 0,
      };
    }
    const choice = evt.choices?.[0];
    if (!choice) continue;
    const text = choice.delta?.content;
    if (typeof text === "string" && text) yield { type: "text", text };
    // 思考增量：DeepSeek/GLM 系用 reasoning_content，部分网关用 reasoning。
    const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
    if (typeof reasoning === "string" && reasoning) {
      yield { type: "thinking", text: reasoning };
    }
    for (const tc of choice.delta?.tool_calls ?? []) {
      const acc = toolAcc.get(tc.index) ?? { id: "", name: "", args: "" };
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name = tc.function.name;
      acc.args += tc.function?.arguments ?? "";
      toolAcc.set(tc.index, acc);
    }
  }

  // Emit aggregated tool calls in index order once the stream is complete.
  const sorted = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]);
  for (const [idx, acc] of sorted) {
    if (!acc.name) continue;
    yield {
      type: "toolCall",
      id: acc.id || `call_${idx + 1}`,
      toolName: acc.name,
      args: parseArgs(acc.args),
    };
  }
}

function parseArgs(raw: string): Record<string, unknown> {
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

interface OpenAIChunk {
  error?: { message?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}
