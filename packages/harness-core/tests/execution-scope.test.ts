import { describe, expect, it } from "vitest";
import {
  createExecutionScope,
  PermissionEngine,
  PluginRegistry,
  runLoop,
  textMessage,
  type Delta,
  type ExecutionScope,
  type Message,
  type Provider,
  type Tool,
} from "../src";

describe("createExecutionScope", () => {
  it("gives every invocation a fresh, unique invocation id", () => {
    const a = createExecutionScope("Read");
    const b = createExecutionScope("Read");
    expect(a.invocationId).not.toBe(b.invocationId);
    expect(a.invocationId).not.toBe("");
    expect(a.toolName).toBe("Read");
    expect(b.toolName).toBe("Read");
  });

  it("accepts an explicit invocation id and keeps it read-only (frozen)", () => {
    const scope = createExecutionScope("Write", "inv-42");
    expect(scope.invocationId).toBe("inv-42");
    expect(() => {
      (scope as { invocationId: string }).invocationId = "tampered";
    }).toThrow();
    expect(() => {
      (scope as { toolName: string }).toolName = "Nope";
    }).toThrow();
  });
});

describe("executor scope lifecycle", () => {
  it("builds a new scope per tool call — session-level scopes never reuse an invocation id", async () => {
    const seen: ExecutionScope[] = [];
    const echo: Tool = {
      name: "Echo",
      description: "echo",
      readOnly: true,
      sideEffect: "none",
      parameters: { type: "object" },
      permissionResource: () => ({ action: "read", kind: "test", scope: "echo" }),
      persistArgs: (args) => ({ ...args }),
      async execute(_args, ctx) {
        seen.push(ctx.scope);
        return { content: "ok" };
      },
    };

    let turn = 0;
    const provider: Provider = {
      id: "scripted",
      async *chat(): AsyncIterable<Delta> {
        turn += 1;
        if (turn === 1) {
          yield { type: "toolCall", id: "c1", toolName: "Echo", args: { n: 1 } };
          yield { type: "toolCall", id: "c2", toolName: "Echo", args: { n: 2 } };
        } else {
          yield { type: "text", text: "done" };
        }
      },
    };

    const registry = new PluginRegistry();
    registry.tools.set("Echo", echo);
    const history: Message[] = [];
    await runLoop(history, textMessage("user", "go"), {
      provider,
      registry,
      permission: new PermissionEngine({
        mode: "auto",
        decider: { ask: async () => "deny" },
      }),
      systemPrompt: "s",
      workspaceRoot: "/tmp/ws",
      onEvent: () => {},
    });

    expect(seen).toHaveLength(2);
    expect(seen[0].invocationId).not.toBe(seen[1].invocationId);
    expect(seen.map((s) => s.toolName)).toEqual(["Echo", "Echo"]);
  });
});
