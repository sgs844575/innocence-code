import { describe, expect, it } from "vitest";
import {
  AgentSession,
  PluginRegistry,
  type Delta,
  type HarnessEvent,
  type Provider,
  type Tool,
} from "@innocencecode/harness-core";
import { subagentPlugin, taskTool } from "../src";

describe("Task tool via session spawner", () => {
  it("spawns a child session that runs tools and reports back to the parent", async () => {
    let childPeeked = 0;
    let parentTurn = 0;
    let childTurn = 0;

    // One provider for both sessions; the child's explore system prompt
    // distinguishes whose conversation each request belongs to.
    const provider: Provider = {
      id: "dual",
      async *chat(req): AsyncIterable<Delta> {
        const isChild = req.system.includes("只读研究代理");
        if (isChild) {
          childTurn += 1;
          if (childTurn === 1) {
            yield { type: "toolCall", id: "c1", toolName: "Peek", args: {} };
          } else {
            yield { type: "text", text: "子代理报告：找到了" };
          }
        } else {
          parentTurn += 1;
          if (parentTurn === 1) {
            yield {
              type: "toolCall",
              id: "p1",
              toolName: "Task",
              args: { agentType: "explore", prompt: "查一下" },
            };
          } else {
            yield { type: "text", text: "父级最终答案" };
          }
        }
      },
    };
    const peekTool: Tool = {
      name: "Peek",
      description: "peek",
      readOnly: true,
      parameters: { type: "object" },
      execute: async () => {
        childPeeked += 1;
        return { content: "peek-result" };
      },
    };

    const session = await AgentSession.create({
      plugins: [
        {
          name: "wire",
          activate(ctx) {
            ctx.registerTool(peekTool);
            ctx.registerTool(taskTool);
          },
        },
      ],
      provider,
      workspaceRoot: "D:/tmp",
      permission: { mode: "auto", decider: { ask: async () => "deny" } },
    });

    const events: HarnessEvent[] = [];
    session.on((e) => events.push(e));
    const result = await session.run("帮我查");

    expect(result.finalText).toBe("父级最终答案");
    expect(childPeeked).toBe(1);
    // The child report became the Task tool result inside the parent history.
    const taskResult = session.history
      .flatMap((m) => m.parts)
      .find((p) => p.type === "toolResult" && p.content.includes("子代理报告"));
    expect(taskResult).toBeDefined();
    // Child tool activity never leaked token-level noise into the parent text.
    expect(result.finalText).not.toContain("peek-result");
  });

  it("reports an error result when the host provides no spawner", async () => {
    const r = await taskTool.execute(
      { agentType: "explore", prompt: "查" },
      {
        workspaceRoot: "D:/tmp",
        signal: new AbortController().signal,
        log: () => {},
        // no subagent
      },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("不支持子代理");
  });
});

describe("subagentPlugin", () => {
  it("registers the Task tool with sane metadata", async () => {
    const reg = new PluginRegistry();
    await reg.load([subagentPlugin]);
    expect(reg.tools.has("Task")).toBe(true);
    expect(reg.tools.get("Task")!.readOnly).toBe(false);
  });
});
