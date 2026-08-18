import type { ChatRequest, Message, MessagePart } from "@innocencecode/harness-core";

/**
 * Maps the canonical message model to the Anthropic messages wire body.
 * Canonical form (tool results as user-message parts) is nearly 1:1.
 */
export function toAnthropicBody(
  req: ChatRequest,
  cfg: { model: string; maxTokens?: number; temperature?: number; reasoningEffort?: string },
): Record<string, unknown> {
  const messages = req.messages
    .map(mapMessage)
    .filter((m) => m.content.length > 0);

  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: cfg.maxTokens ?? 8192,
    stream: true,
    messages,
  };
  if (req.system) body.system = req.system;
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  if (cfg.temperature !== undefined) body.temperature = cfg.temperature;
  // 思考档位 → extended thinking 预算；开启时 max_tokens 必须大于预算。
  if (cfg.reasoningEffort && cfg.reasoningEffort !== "off") {
    const budget = THINKING_BUDGET[cfg.reasoningEffort] ?? THINKING_BUDGET.high;
    body.thinking = { type: "enabled", budget_tokens: budget };
    body.max_tokens = Math.max(cfg.maxTokens ?? 8192, budget + 8192);
  }
  return body;
}

const THINKING_BUDGET: Record<string, number> = { low: 4096, medium: 16384, high: 32768 };

function mapMessage(m: Message): { role: string; content: unknown[] } {
  return { role: m.role, content: m.parts.map(mapPart).filter((p) => p !== null) };
}

function mapPart(p: MessagePart): Record<string, unknown> | null {
  switch (p.type) {
    case "text":
      return p.text ? { type: "text", text: p.text } : null;
    case "toolCall":
      return { type: "tool_use", id: p.id, name: p.toolName, input: p.args };
    case "toolResult":
      return { type: "tool_result", tool_use_id: p.toolCallId, content: p.content };
  }
}
