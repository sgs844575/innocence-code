import { describe, expect, it } from "vitest";
import {
  PermissionEngine,
  resourceGrantKey,
  type AskResponse,
  type PermissionAuditEntry,
  type PermissionRequest,
  type PolicyRule,
} from "@innocencecode/harness-permissions";

function request(
  toolName: string,
  action: string,
  scope: string,
  kind = "path",
  args: Record<string, unknown> = {},
): PermissionRequest {
  return { toolName, resource: { action, kind, scope }, args };
}

function recordingDecider(answer: AskResponse) {
  const requests: PermissionRequest[] = [];
  return {
    requests,
    decider: {
      ask: async (req: PermissionRequest) => {
        requests.push(req);
        return answer;
      },
    },
  };
}

const readReq = request("Read", "read", "src/a.ts");
const editReq = request("Edit", "write", "src/a.ts", "path", { path: "src/a.ts" });
const bashReq = request("Bash", "execute", "npm", "command", { command: "npm" });
const write = { readOnly: false, sideEffect: "paths" as const };
const read = { readOnly: true, sideEffect: "none" as const };

describe("resourceGrantKey", () => {
  it("joins tool name and canonical resource fields with \\u0000", () => {
    expect(resourceGrantKey("Write", { action: "write", kind: "path", scope: "src/a.ts" })).toBe(
      "Write\u0000write\u0000path\u0000src/a.ts",
    );
    expect(resourceGrantKey("Bash", { action: "execute", kind: "command", scope: "npm" })).toBe(
      "Bash\u0000execute\u0000command\u0000npm",
    );
  });

  it("distinguishes actions and kinds on the same scope", () => {
    const a = resourceGrantKey("T", { action: "read", kind: "path", scope: "x" });
    const b = resourceGrantKey("T", { action: "write", kind: "path", scope: "x" });
    const c = resourceGrantKey("T", { action: "read", kind: "url", scope: "x" });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("PermissionEngine pipeline", () => {
  it("deny rules win over everything, including auto mode", async () => {
    const { decider } = recordingDecider("allow");
    const engine = new PermissionEngine({ mode: "auto", decider });
    engine.addRules([
      { name: "deny:Edit(src/**)", match: (c) => (c.toolName === "Edit" ? "deny" : "skip") },
      { name: "allow:Edit", match: (c) => (c.toolName === "Edit" ? "allow" : "skip") },
    ]);
    const r = await engine.resolve(editReq, write);
    expect(r.decision).toBe("deny");
    expect(r.via).toBe("denyRule");
  });

  it("full mode (完全访问) bypasses even deny rules without asking", async () => {
    const { decider, requests } = recordingDecider("deny");
    const engine = new PermissionEngine({ mode: "full", decider });
    engine.addRules([
      { name: "deny:Edit(src/**)", match: (c) => (c.toolName === "Edit" ? "deny" : "skip") },
    ]);
    const r = await engine.resolve(editReq, write);
    expect(r.decision).toBe("allow");
    expect(r.via).toBe("fullMode");
    expect(requests).toHaveLength(0); // 不弹任何询问
  });

  it("plan mode auto-allows readOnly (planReadOnly) without asking and denies writes (planMode)", async () => {
    const { decider, requests } = recordingDecider("deny");
    const engine = new PermissionEngine({ mode: "plan", decider });
    const r = await engine.resolve(readReq, read);
    expect(r.decision).toBe("allow");
    expect(r.via).toBe("planReadOnly");
    expect(requests).toHaveLength(0); // 只读探索自由：不弹 decider
    const w = await engine.resolve(editReq, write);
    expect(w.decision).toBe("deny");
    expect(w.via).toBe("planMode");
    expect(requests).toHaveLength(0);
  });

  it("plan mode deny rules still win over the planReadOnly short-circuit", async () => {
    const { decider, requests } = recordingDecider("allow");
    const engine = new PermissionEngine({ mode: "plan", decider });
    engine.addRules([
      { name: "deny:Read(src/**)", match: (c) => (c.toolName === "Read" ? "deny" : "skip") },
    ]);
    const r = await engine.resolve(readReq, read);
    expect(r.decision).toBe("deny");
    expect(r.via).toBe("denyRule");
    expect(requests).toHaveLength(0);
  });

  it("readOnly tools still ask in ask mode — planReadOnly only applies to plan mode", async () => {
    const { decider, requests } = recordingDecider("deny");
    const engine = new PermissionEngine({ mode: "ask", decider });
    const r = await engine.resolve(readReq, read);
    expect(r.decision).toBe("deny");
    expect(r.via).toBe("ask");
    expect(requests).toHaveLength(1);
  });

  it("allow rules admit calls in ask mode without asking", async () => {
    const { decider, requests } = recordingDecider("deny");
    const engine = new PermissionEngine({ mode: "ask", decider });
    engine.addRules([
      { name: "allow:Bash(npm)", match: () => "allow" } as PolicyRule,
    ]);
    const r = await engine.resolve(bashReq, { readOnly: false, sideEffect: "process" });
    expect(r.decision).toBe("allow");
    expect(r.via).toBe("allowRule");
    expect(requests).toHaveLength(0);
  });

  it("auto mode allows without asking", async () => {
    const { decider, requests } = recordingDecider("deny");
    const engine = new PermissionEngine({ mode: "auto", decider });
    expect((await engine.resolve(editReq, write)).via).toBe("autoMode");
    expect(requests).toHaveLength(0);
  });

  it("ask mode consults decider; allowSession writes a subcommand-granular resource grant", async () => {
    const { decider, requests } = recordingDecider("allowSession");
    const engine = new PermissionEngine({ mode: "ask", decider });
    const bash = (summary: string) => request("Bash", "execute", summary, "command", { command: summary });
    const first = await engine.resolve(bash("npm test"), { readOnly: false, sideEffect: "process" });
    expect(first.decision).toBe("allow");
    expect(first.via).toBe("ask");
    expect(requests).toHaveLength(1);

    // The same canonical summary (flags never enter it) reuses the grant.
    const second = await engine.resolve(bash("npm test"), { readOnly: false, sideEffect: "process" });
    expect(second.via).toBe("sessionGrant");
    expect(requests).toHaveLength(1);

    // A different subcommand under the same program must NOT ride the grant:
    // allowing `npm test` never admits `npm publish`.
    const third = await engine.resolve(bash("npm publish"), { readOnly: false, sideEffect: "process" });
    expect(third.via).toBe("ask");
    expect(third.decision).toBe("allow");
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.resource.scope)).toEqual(["npm test", "npm publish"]);
  });

  it("does not reuse a session grant for another resource", async () => {
    const asked: string[] = [];
    const engine = new PermissionEngine({
      mode: "ask",
      decider: {
        ask: async (req) => {
          asked.push(req.resource.scope);
          return "allowSession";
        },
      },
    });

    await engine.resolve(request("Write", "write", "src/a.ts"), { readOnly: false, sideEffect: "paths" });
    await engine.resolve(request("Write", "write", "src/b.ts"), { readOnly: false, sideEffect: "paths" });

    expect(asked).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("decider deny denies", async () => {
    const { decider } = recordingDecider("deny");
    const engine = new PermissionEngine({ mode: "ask", decider });
    expect((await engine.resolve(bashReq, { readOnly: false, sideEffect: "process" })).decision).toBe("deny");
  });

  it("runs hard resource validation in full mode", async () => {
    const engine = new PermissionEngine({
      mode: "full",
      decider: { ask: async () => "allow" },
      validateResource: async () => {
        throw new Error("blocked resource");
      },
    });

    await expect(
      engine.resolve(request("BrowserNavigate", "navigate", "file:///secret", "url"), {
        readOnly: false,
        sideEffect: "unknown",
      }),
    ).rejects.toThrow("blocked resource");
  });

  it("runs hard resource validation in ask mode too (fail-closed)", async () => {
    const { decider, requests } = recordingDecider("allow");
    const engine = new PermissionEngine({
      mode: "ask",
      decider,
      validateResource: (resource) => {
        if (resource.kind === "url") throw new Error("blocked resource");
      },
    });

    await expect(
      engine.resolve(request("BrowserNavigate", "navigate", "file:///secret", "url"), {
        readOnly: false,
        sideEffect: "unknown",
      }),
    ).rejects.toThrow("blocked resource");
    expect(requests).toHaveLength(0); // never reached the ask stage
  });

  it("audits validateResource rejections as a deny before rethrowing", async () => {
    const entries: PermissionAuditEntry[] = [];
    const engine = new PermissionEngine({
      mode: "ask",
      decider: { ask: async () => "allow" },
      validateResource: () => {
        throw new Error("blocked resource");
      },
      audit: (entry) => entries.push(entry),
    });

    await expect(
      engine.resolve(request("BrowserNavigate", "navigate", "file:///secret", "url"), {
        readOnly: false,
        sideEffect: "unknown",
      }),
    ).rejects.toThrow("blocked resource");

    // Exactly one ledger entry for the rejected gate — decision deny, via validateResource.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.resolution).toEqual({
      decision: "deny",
      via: "validateResource",
      reason: "blocked resource",
    });
    expect(entries[0]!.request.resource.scope).toBe("file:///secret");
    expect(entries[0]!.tool).toEqual({ readOnly: false, sideEffect: "unknown" });
  });

  it("audits every resolution, including full mode", async () => {
    const entries: PermissionAuditEntry[] = [];
    const engine = new PermissionEngine({
      mode: "full",
      decider: { ask: async () => "deny" },
      audit: (entry) => entries.push(entry),
    });
    const resolution = await engine.resolve(editReq, write);
    expect(resolution.via).toBe("fullMode");
    expect(entries).toHaveLength(1);
    expect(entries[0].mode).toBe("full");
    expect(entries[0].resolution).toEqual(resolution);
    expect(entries[0].request.resource.scope).toBe("src/a.ts");
    expect(entries[0].tool).toEqual({ readOnly: false, sideEffect: "paths" });
  });

  it("audits ask-mode decisions with the persisted request", async () => {
    const entries: PermissionAuditEntry[] = [];
    const engine = new PermissionEngine({
      mode: "ask",
      decider: { ask: async () => "deny" },
      audit: (entry) => entries.push(entry),
    });
    await engine.resolve(editReq, write);
    expect(entries).toHaveLength(1);
    expect(entries[0].request.args).toEqual({ path: "src/a.ts" });
    expect(entries[0].resolution.decision).toBe("deny");
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
      request("Edit", "write", "src/a.ts", "path", { path: "D:\\work\\proj\\src\\a.ts" }),
      write,
    );
    expect(r.decision).toBe("allow");
    expect(r.via).toBe("allowRule");
  });
});
