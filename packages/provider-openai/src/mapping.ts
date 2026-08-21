import type { ChatRequest } from "@innocencecode/harness-providers";

/**
 * Maps the canonical message model to the OpenAI chat-completions wire body.
 * Pure function — fully covered by unit tests without network.
 */
export function toOpenAIBody(
  req: ChatRequest,
  cfg: { model: string; maxTokens?: number; temperature?: number; reasoningEffort?: string },
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (req.system) messages.push({ role: "system", content: req.system });

  for (const m of req.messages) {
    if (m.role === "assistant") {
      const text = m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      const toolCalls = m.parts
        .filter((p) => p.type === "toolCall")
        .map((p) => ({
          id: p.id,
          type: "function",
          function: { name: p.toolName, arguments: JSON.stringify(p.args) },
        }));
      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // Canonical user messages carry tool results (Anthropic-style blocks);
      // OpenAI wants each as its own role:"tool" message, trailing text as user.
      for (const p of m.parts) {
        if (p.type === "toolResult") {
          messages.push({
            role: "tool",
            tool_call_id: p.toolCallId,
            content: p.content,
          });
        }
      }
      const text = m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      if (text) messages.push({ role: "user", content: text });
    }
  }

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (cfg.maxTokens !== undefined) body.max_tokens = cfg.maxTokens;
  if (cfg.temperature !== undefined) body.temperature = cfg.temperature;
  // 思考档位（o系列/gpt-5/GLM 等 OpenAI 兼容端点的 reasoning_effort）；
  // "off"/未设置 = 不带参数（跟随模型默认）。
  if (cfg.reasoningEffort && cfg.reasoningEffort !== "off") {
    body.reasoning_effort = cfg.reasoningEffort;
  }
  return body;
}
