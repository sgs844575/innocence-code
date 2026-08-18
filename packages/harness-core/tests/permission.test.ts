import { describe, expect, it } from "vitest";
import {
  PermissionEngine,
  defaultGrantKey,
  type AskResponse,
  type PolicyRule,
  type ToolCallInfo,
} from "../src";

function recordingDecider(answer: AskResponse) {
  const calls: ToolCallInfo[] = [];
  return {
    calls,
    decider: {
      ask: async (call: ToolCallInfo) => {
        calls.push(call);
        return answer;
      },
    },
  };
}

const readCall: ToolCallInfo = { toolName: "Read", args: { path: "src/a.ts" } };
const editCall: ToolCallInfo = { toolName: "Edit", args: { path: "src/a.ts" } };
const bashCall: ToolCallInfo = { toolName: "Bash", args: { command: "npm test" } };

describe("PermissionEngine pipeline", () => {
  it("deny rules win over everything, including auto mode", async () => {
    const { decider } = recordingDecider("allow");
    const engine = new PermissionEngine({ mode: "auto", decider });
    engine.addRules([
      { name: "deny:Edit(src/**)", match: (c) => (c.toolName === "Edit" ? "deny" : "skip") },
      { name: "allow:Edit", match: (c) => (c.toolName === "Edit" ? "allow" : "skip") },
    ]);
    const r = await engine.resolve(editCall, { readOnly: false });
    expect(r.decision).toBe("deny");
    expect(r.via).toBe("denyRule");
  });

  it("full mode (完全访问) bypasses even deny rules without asking", async () => {
    const { decider, calls } = recordingDecider("deny");
    const engine = new PermissionEngine({ mode: "full", decider });
    engine.addRules([
      { name: "deny:Edit(src/**)", match: (c) => (c.toolName === "Edit" ? "deny" : "skip") },
    ]);
    const r = await engine.resolve(editCall, { readOnly: false });
    expect(r.decision).toBe("allow");
    expect(r.via).toBe("fullMode");
    expect(calls).toHaveLength(0); // 不弹任何询问
  });

  it("plan mode allows readOnly but denies writes", async () => {
    const { decider } = recordingDecider("allow");
    const engine = new PermissionEngine({ mode: "plan", decider });
    expect((await engine.resolve(readCall, { readOnly: true })).decision).toBe("allow");
    const r = await engine.resolve(editCall, { readOnly: false });
    expect(r.decision).toBe("deny");
    expect(r.via).toBe("planMode");
  });

  it("allow rules admit calls in ask mode without asking", async () => {
    const { decider, calls } = recordingDecider("deny");
    const engine = new PermissionEngine({ mode: "ask", decider });
    engine.addRules([
      { name: "allow:Bash(npm test)", match: () => "allow" } as PolicyRule,
    ]);
    const r = await engine.resolve(bashCall, { readOnly: false });
    expect(r.decision).toBe("allow");
    expect(r.via).toBe("allowRule");
    expect(calls).toHaveLength(0);
  });

  it("auto mode allows without asking", async () => {
    const { decider, calls } = recordingDecider("deny");
    const engine = new PermissionEngine({ mode: "auto", decider });
    expect((await engine.resolve(editCall, { readOnly: false })).via).toBe("autoMode");
    expect(calls).toHaveLength(0);
  });

  it("ask mode consults decider; allowSession writes a session grant", async () => {
    const { decider, calls } = recordingDecider("allowSession");
    const engine = new PermissionEngine({ mode: "ask", decider });
    const first = await engine.resolve(bashCall, { readOnly: false });
    expect(first.decision).toBe("allow");
    expect(first.via).toBe("ask");
    expect(calls).toHaveLength(1);

    // Second identical command hits the session grant without asking again.
    const second = await engine.resolve(
      { toolName: "Bash", args: { command: "npm test -- -u" } },
      { readOnly: false },
    );
    expect(second.via).toBe("sessionGrant");
    expect(calls).toHaveLength(1);

    // A different command still asks.
    await engine.resolve({ toolName: "Bash", args: { command: "rm -rf /" } }, { readOnly: false });
    expect(calls).toHaveLength(2);
  });

  it("decider deny denies", async () => {
    const { decider } = recordingDecider("deny");
    const engine = new PermissionEngine({ mode: "ask", decider });
    expect((await engine.resolve(bashCall, { readOnly: false })).decision).toBe("deny");
  });

  it("defaultGrantKey keys command tools on first word", () => {
    expect(defaultGrantKey(bashCall)).toBe("Bash(npm)");
    expect(defaultGrantKey(editCall)).toBe("Edit");
  });
});

describe("PermissionEngine path normalization", () => {
  it("absolute paths under the root become relative for rule matching", async () => {
    const { decider } = recordingDecider("deny");
    const engine = new PermissionEngine({
      mode: "ask",
      decider,
      workspaceRoot: "D:/work/proj",
    });
    engine.addRules([
      {
        name: "allow:Edit(src/**)",
        match: (c) =>
          c.toolName === "Edit" &&
          typeof c.args.path === "string" &&
          c.args.path.startsWith("src/")
            ? "allow"
            : "skip",
      },
    ]);
    const r = await engine.resolve(
      { toolName: "Edit", args: { path: "D:\\work\\proj\\src\\a.ts" } },
      { readOnly: false },
    );
    expect(r.decision).toBe("allow");
    expect(r.via).toBe("allowRule");
  });
});
