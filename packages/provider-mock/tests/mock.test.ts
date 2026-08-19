import { describe, expect, it } from "vitest";
import {
  SUMMARIZE_SYSTEM_PROMPT,
  runLoop,
  PluginRegistry,
  PermissionEngine,
  textMessage,
} from "@innocencecode/harness-core";
import { createMockProvider } from "../src";

describe("createMockProvider", () => {
  it("streams text in chunks then complete tool calls, script advances per turn", async () => {
    const provider = createMockProvider({
      turns: [
        { text: "让我看看", toolCalls: [{ toolName: "Read", args: { path: "a.ts" } }] },
        { text: "完成" },
      ],
      chunkSize: 2,
    });
    const registry = new PluginRegistry();
    registry.tools.set("Read", {
      name: "Read",
      description: "r",
      readOnly: true,
      parameters: { type: "object" },
      permissionResource: () => ({ action: "read", kind: "path", scope: "a.ts" }),
      persistArgs: (args) => ({ ...args }),
      execute: async () => ({ content: "file-content" }),
    });
    const events: string[] = [];
    const result = await runLoop([], textMessage("user", "读一下"), {
      provider,
      registry,
      permission: new PermissionEngine({ mode: "auto", decider: { ask: async () => "deny" } }),
      systemPrompt: "s",
      workspaceRoot: "/tmp",
      onEvent: (e) => events.push(e.type),
    });
    expect(result.finalText).toBe("完成");
    expect(events.filter((t) => t === "toolCall")).toHaveLength(1);
    expect(events.filter((t) => t === "token").length).toBeGreaterThan(1);
  });

  it("answers compaction summary requests without consuming the script", async () => {
    const provider = createMockProvider({
      turns: [{ text: "A" }, { text: "B" }],
      summarizeResponse: "SUMMARY",
    });
    const seenSystems: string[] = [];
    const p = createMockProvider({
      turns: [{ text: "A" }, { text: "B" }],
      summarizeResponse: "SUMMARY",
      onChat: (req) => seenSystems.push(req.system),
    });
    // Consume a summary request first, then a normal turn.
    const summaryIter = p.chat({ system: SUMMARIZE_SYSTEM_PROMPT, messages: [], tools: [] });
    let summary = "";
    for await (const d of summaryIter) if (d.type === "text") summary += d.text;
    expect(summary).toBe("SUMMARY");
    const turnIter = provider.chat({ system: "normal", messages: [], tools: [] });
    let text = "";
    for await (const d of turnIter) if (d.type === "text") text += d.text;
    expect(text).toBe("A"); // script not consumed by the summary request
    expect(seenSystems).toContain(SUMMARIZE_SYSTEM_PROMPT);
  });

  it("emits exhausted text once the script runs out", async () => {
    const provider = createMockProvider({ turns: [], exhaustedText: "END" });
    const iter = provider.chat({ system: "s", messages: [], tools: [] });
    const deltas = [];
    for await (const d of iter) deltas.push(d);
    expect(deltas).toEqual([{ type: "text", text: "END" }]);
  });
});
