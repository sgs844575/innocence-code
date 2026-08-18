import type { ToolCallPart, ToolResultPart } from "../../../../shared/ipc";

export interface ToolPair { call: ToolCallPart; result?: ToolResultPart }

export function pairTools(parts: (ToolCallPart | ToolResultPart)[]): ToolPair[] {
  const pairs = new Map<string, ToolPair>();
  for (const p of parts) {
    if (p.type === "toolCall") pairs.set(p.id, { call: p });
    else {
      const hit = pairs.get(p.toolCallId);
      if (hit) hit.result = p;
    }
  }
  return [...pairs.values()];
}

export interface TurnSummary { count: number; tools: string[]; totalMs: number }

export function summarizeTurn(parts: (ToolCallPart | ToolResultPart)[]): TurnSummary {
  const pairs = pairTools(parts);
  const names = new Map<string, number>();
  let totalMs = 0;
  for (const { call, result } of pairs) {
    names.set(call.toolName, (names.get(call.toolName) ?? 0) + 1);
    totalMs += result?.durationMs ?? 0;
  }
  return {
    count: pairs.length,
    tools: [...names.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)),
    totalMs,
  };
}
