import { describe, expect, it, vi } from "vitest";
import { Context } from "@innocencecode/kernel";
import { ToolsPlugin } from "@innocencecode/harness-tools";
import {
  AgentSession,
  createExecutionScope,
  sha256Hex,
  type Delta,
  type ExecutionScope,
  type HarnessEvent,
  type Message,
  type Provider,
  type Tool,
  type ToolExecutionMiddleware,
} from "@innocencecode/harness-core";
import { SubagentPlugin, taskTool } from "../src";

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
      sideEffect: "none",
      parameters: { type: "object" },
      permissionResource: () => ({ action: "read", kind: "test", scope: "peek" }),
      persistArgs: (args) => ({ ...args }),
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
          },
        },
        SubagentPlugin,
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
        scope: createExecutionScope("Task"),
        // no subagent
      },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("不支持子代理");
  });

  it("child sessions inherit processors, middleware and the parent run scope", async () => {
    let childPeeked = 0;
    let parentTurn = 0;
    let childTurn = 0;
    let childUser: Message | undefined;
    let taskScope: ExecutionScope | undefined;
    let peekScope: ExecutionScope | undefined;

    const provider: Provider = {
      id: "dual",
      async *chat(req): AsyncIterable<Delta> {
        const isChild = req.system.includes("只读研究代理");
        if (isChild) {
          childTurn += 1;
          if (childTurn === 1) {
            childUser = req.messages[0];
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
      sideEffect: "none",
      parameters: { type: "object" },
      permissionResource: () => ({ action: "read", kind: "test", scope: "peek" }),
      persistArgs: (args) => ({ ...args }),
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
            ctx.registerMessageProcessor({
              name: "mark",
              order: 0,
              async process(message) {
                return { ...message, parts: [...message.parts, { type: "text", text: " [marked]" }] };
              },
            });
          },
        },
        SubagentPlugin,
      ],
      provider,
      workspaceRoot: "D:/tmp",
      permission: { mode: "auto", decider: { ask: async () => "deny" } },
    });
    const recorder: ToolExecutionMiddleware = {
      name: "scope-recorder",
      async execute(invocation, next) {
        if (invocation.toolName === "Task") taskScope = invocation.scope;
        else peekScope = invocation.scope;
        return next();
      },
    };
    session.registry.createContext("scope-recorder", () => {}).registerToolMiddleware(recorder);

    const result = await session.run("帮我查", undefined, { taskId: "task-42" });

    expect(result.finalText).toBe("父级最终答案");
    expect(childPeeked).toBe(1);
    // Middleware inheritance: the child's Peek call ran through the same
    // middleware object registered on the parent registry.
    expect(taskScope).toBeDefined();
    expect(peekScope).toBeDefined();
    expect(taskScope!.invocationId).toMatch(/^inv-/);
    // Scope inheritance: sessionId/taskId/routeId match the parent Task call.
    expect(peekScope!.sessionId).toBe(taskScope!.sessionId);
    expect(peekScope!.sessionId).toMatch(/^sess-/);
    expect(peekScope!.routeId).toBe(taskScope!.routeId);
    expect(peekScope!.routeId).toMatch(/^route-/);
    expect(peekScope!.taskId).toBe("task-42");
    expect(peekScope!.parentInvocationId).toBe(taskScope!.invocationId);
    expect(peekScope!.invocationId).not.toBe(taskScope!.invocationId);
    // Processor inheritance: the child's prompt went through the parent's
    // processor before entering the child loop.
    expect(childUser?.parts.at(-1)).toMatchObject({ type: "text", text: " [marked]" });
  });

  it("disposes the child session in a finally after a successful spawn", async () => {
    let parentTurn = 0;
    const provider: Provider = {
      id: "dual",
      async *chat(req): AsyncIterable<Delta> {
        if (req.system.includes("只读研究代理")) {
          yield { type: "text", text: "子代理报告" };
        } else {
          parentTurn += 1;
          if (parentTurn === 1) {
            yield { type: "toolCall", id: "p1", toolName: "Task", args: { agentType: "explore", prompt: "查一下" } };
          } else {
            yield { type: "text", text: "父级最终答案" };
          }
        }
      },
    };
    const session = await AgentSession.create({
      plugins: [SubagentPlugin],
      provider,
      workspaceRoot: "D:/tmp",
      permission: { mode: "auto", decider: { ask: async () => "deny" } },
    });
    const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose");
    try {
      const result = await session.run("帮我查");
      expect(result.finalText).toBe("父级最终答案");
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      disposeSpy.mockRestore();
    }
  });

  it("disposes the child session even when the spawn fails", async () => {
    let parentTurn = 0;
    const provider: Provider = {
      id: "dual",
      async *chat(req): AsyncIterable<Delta> {
        if (req.system.includes("只读研究代理")) {
          yield { type: "text", text: "不应到达" };
        } else {
          parentTurn += 1;
          if (parentTurn === 1) {
            yield { type: "toolCall", id: "p1", toolName: "Task", args: { agentType: "explore", prompt: "poison 查一下" } };
          } else {
            yield { type: "text", text: "父级收到错误" };
          }
        }
      },
    };
    const session = await AgentSession.create({
      plugins: [
        SubagentPlugin,
        {
          name: "wire",
          activate(ctx) {
            ctx.registerMessageProcessor({
              name: "poison-guard",
              order: 0,
              async process(message) {
                if (message.parts.some((p) => p.type === "text" && p.text.includes("poison"))) {
                  throw new Error("poison input rejected");
                }
                return message;
              },
            });
          },
        },
      ],
      provider,
      workspaceRoot: "D:/tmp",
      permission: { mode: "auto", decider: { ask: async () => "deny" } },
    });
    const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose");
    try {
      const result = await session.run("开始");
      expect(result.finalText).toBe("父级收到错误");
      const taskResult = session.history
        .flatMap((m) => m.parts)
        .find((p) => p.type === "toolResult");
      expect(taskResult).toMatchObject({ isError: true });
      expect(JSON.stringify(taskResult)).toContain("poison input rejected");
      expect(disposeSpy).toHaveBeenCalledTimes(1); // disposed on the failure path
    } finally {
      disposeSpy.mockRestore();
    }
  });
});

describe("taskTool persistence policy", () => {
  const SECRET = "TASK-PLUGIN-SECRET-3f9c";

  it("persists the agent type and a prompt hash, never the prompt", () => {
    const persisted = taskTool.persistArgs({
      agentType: "general",
      description: `任务：处理 ${SECRET}`,
      prompt: `use ${SECRET}`,
    });
    expect(persisted).toEqual({
      agentType: "general",
      promptSha256: sha256Hex(`use ${SECRET}`),
    });
    expect(JSON.stringify(persisted)).not.toContain(SECRET);
  });

  it("resources key on the agent type", () => {
    const resource = taskTool.permissionResource(
      { agentType: "explore", prompt: SECRET },
      {
        workspaceRoot: "D:/tmp",
        signal: new AbortController().signal,
        log: () => {},
        scope: createExecutionScope("Task"),
      },
    );
    expect(resource).toEqual({ action: "spawn", kind: "agent", scope: "explore" });
  });

  it("validateArgs requires a non-empty prompt", async () => {
    await expect(taskTool.validateArgs?.({ agentType: "explore", prompt: " " })).rejects.toThrow(
      "prompt",
    );
  });
});

/** Mounts the plugin on a bare kernel context (tools spine service only). */
async function mountSubagent(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(ToolsPlugin);
  await ctx.plugin(SubagentPlugin);
  return ctx;
}

describe("SubagentPlugin", () => {
  it("registers the Task tool with sane metadata", async () => {
    const ctx = await mountSubagent();
    expect(ctx.tools.get("Task")).toBeDefined();
    expect(ctx.tools.get("Task")!.readOnly).toBe(false);
    // The child session audits its own tool effects — the parent must not
    // double-count them (P1 plugin-task keys on this value).
    expect(ctx.tools.get("Task")).toMatchObject({ sideEffect: "delegated" });
  });
});
