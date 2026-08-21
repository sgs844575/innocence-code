import { describe, expect, it } from "vitest";
import { Context } from "@innocencecode/kernel";
import { ToolsPlugin } from "@innocencecode/harness-tools";
import {
  PermissionEngine,
  redactCommand,
  redactCommandSummary,
  redactUrl,
  runLoop,
  sha256Hex,
  textMessage,
  toTranscript,
  type Delta,
  type HarnessEvent,
  type Message,
  type PermissionAuditEntry,
  type PermissionRequest,
  type Provider,
  type Tool,
} from "../src";

/**
 * One unique secret per tool family. Each fake tool receives its secret in
 * raw execution args; the assertions below prove the secret reaches execute
 * and reaches NOTHING else (history, events, permission requests, audit,
 * transcript, resources).
 */
const SECRETS = {
  write: "WRITE-SECRET-9f1ac3",
  edit: "EDIT-SECRET-7c2bd1",
  bash: "BASH-SECRET-5d3ee7",
  mcp: "MCP-SECRET-3e8f22",
  task: "TASK-SECRET-1a9c55",
  browser: "browser-secret-0b7d44",
} as const;

const ALL_SECRETS = Object.values(SECRETS);

/** Write-style: path + full content. Persisted: path, length, SHA-256. */
function writeStyleTool(): Tool & { raw: Array<Record<string, unknown>> } {
  const raw: Array<Record<string, unknown>> = [];
  return {
    name: "Write",
    description: "write",
    readOnly: false,
    sideEffect: "paths",
    parameters: { type: "object" },
    async validateArgs(args) {
      if (typeof args.path !== "string" || typeof args.content !== "string") {
        throw new Error("Write 需要 path 与 content");
      }
    },
    permissionResource: (args) => ({
      action: "write",
      kind: "path",
      scope: String(args.path),
    }),
    persistArgs: (args) => ({
      path: String(args.path),
      contentLength: String(args.content).length,
      contentSha256: sha256Hex(String(args.content)),
    }),
    raw,
    async execute(args) {
      raw.push(args);
      return { content: "written" };
    },
  };
}

/** Edit-style: old/new strings both stay raw-only. */
function editStyleTool(): Tool & { raw: Array<Record<string, unknown>> } {
  const raw: Array<Record<string, unknown>> = [];
  return {
    name: "Edit",
    description: "edit",
    readOnly: false,
    sideEffect: "paths",
    parameters: { type: "object" },
    permissionResource: (args) => ({
      action: "write",
      kind: "path",
      scope: String(args.path),
    }),
    persistArgs: (args) => ({
      path: String(args.path),
      contentLength: String(args.new_string).length,
      contentSha256: sha256Hex(String(args.new_string)),
    }),
    raw,
    async execute(args) {
      raw.push(args);
      return { content: "edited" };
    },
  };
}

/** Bash-style: command summary (program word) + full-command hash. */
function bashStyleTool(): Tool & { raw: Array<Record<string, unknown>> } {
  const raw: Array<Record<string, unknown>> = [];
  return {
    name: "Bash",
    description: "bash",
    readOnly: false,
    sideEffect: "process",
    parameters: { type: "object" },
    permissionResource: (args) => ({
      action: "execute",
      kind: "command",
      scope: redactCommandSummary(String(args.command)),
    }),
    persistArgs: (args) => {
      const command = String(args.command);
      return {
        command: redactCommandSummary(command),
        commandSha256: sha256Hex(command),
      };
    },
    raw,
    async execute(args) {
      raw.push(args);
      return { content: "ran" };
    },
  };
}

/** MCP-style: server/tool, parameter names and an args hash. */
function mcpStyleTool(): Tool & { raw: Array<Record<string, unknown>> } {
  const raw: Array<Record<string, unknown>> = [];
  return {
    name: "mcp__ci__deploy",
    description: "mcp",
    readOnly: false,
    sideEffect: "unknown",
    parameters: { type: "object" },
    permissionResource: () => ({
      action: "call",
      kind: "mcp",
      scope: "ci/deploy",
    }),
    persistArgs: (args) => ({
      server: "ci",
      tool: "deploy",
      params: Object.keys(args),
      argsSha256: sha256Hex(JSON.stringify(args, Object.keys(args).sort())),
    }),
    raw,
    async execute(args) {
      raw.push(args);
      return { content: "deployed" };
    },
  };
}

/** Task-style: agent type + prompt hash. */
function taskStyleTool(): Tool & { raw: Array<Record<string, unknown>> } {
  const raw: Array<Record<string, unknown>> = [];
  return {
    name: "Task",
    description: "task",
    readOnly: false,
    sideEffect: "unknown",
    parameters: { type: "object" },
    permissionResource: (args) => ({
      action: "spawn",
      kind: "agent",
      scope: String(args.agentType ?? "explore"),
    }),
    persistArgs: (args) => ({
      agentType: String(args.agentType ?? "explore"),
      promptSha256: sha256Hex(String(args.prompt ?? "")),
    }),
    raw,
    async execute(args) {
      raw.push(args);
      return { content: "tasked" };
    },
  };
}

/** Browser-style: URL loses user-info, query and fragment everywhere persisted. */
function browserStyleTool(): Tool & { raw: Array<Record<string, unknown>> } {
  const raw: Array<Record<string, unknown>> = [];
  return {
    name: "BrowserNavigate",
    description: "navigate",
    readOnly: false,
    sideEffect: "network",
    parameters: { type: "object" },
    permissionResource: (args) => ({
      action: "navigate",
      kind: "url",
      scope: redactUrl(String(args.url)),
    }),
    persistArgs: (args) => ({
      url: redactUrl(String(args.url)),
    }),
    raw,
    async execute(args) {
      raw.push(args);
      return { content: "navigated" };
    },
  };
}

interface RunCapture {
  history: Message[];
  events: HarnessEvent[];
  audit: PermissionAuditEntry[];
  requests: PermissionRequest[];
  raws: Record<string, Array<Record<string, unknown>>>;
  persistCalls: Record<string, number>;
}

/** Runs one scripted turn that invokes every fake tool once. */
async function runWithAllTools(): Promise<RunCapture> {
  const tools = {
    Write: writeStyleTool(),
    Edit: editStyleTool(),
    Bash: bashStyleTool(),
    "mcp__ci__deploy": mcpStyleTool(),
    Task: taskStyleTool(),
    BrowserNavigate: browserStyleTool(),
  };
  const persistCalls: Record<string, number> = {};
  for (const tool of Object.values(tools)) {
    const inner = tool.persistArgs.bind(tool);
    tool.persistArgs = (args) => {
      persistCalls[tool.name] = (persistCalls[tool.name] ?? 0) + 1;
      return inner(args);
    };
  }

  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [
    { toolName: "Write", args: { path: "notes.txt", content: `token=${SECRETS.write}` } },
    {
      toolName: "Edit",
      args: { path: "notes.txt", old_string: `old ${SECRETS.edit}`, new_string: `new ${SECRETS.edit}` },
    },
    { toolName: "Bash", args: { command: `deploy --token=${SECRETS.bash}` } },
    { toolName: "mcp__ci__deploy", args: { apiKey: SECRETS.mcp } },
    { toolName: "Task", args: { agentType: "general", prompt: `use ${SECRETS.task}` } },
    {
      toolName: "BrowserNavigate",
      args: { url: `https://user:${SECRETS.browser}@example.com/path?q=1#frag` },
    },
  ];

  let turn = 0;
  const provider: Provider = {
    id: "scripted",
    async *chat(): AsyncIterable<Delta> {
      turn += 1;
      if (turn === 1) {
        for (const [n, call] of calls.entries()) {
          yield { type: "toolCall", id: `c${n}`, toolName: call.toolName, args: call.args };
        }
      } else {
        yield { type: "text", text: "all done" };
      }
    },
  };

  const kernel = new Context();
  await kernel.plugin(ToolsPlugin);
  for (const tool of Object.values(tools)) {
    // Route through the tools service so the SPI gate is exercised too.
    kernel.tools.register(tool);
  }

  const events: HarnessEvent[] = [];
  const audit: PermissionAuditEntry[] = [];
  const requests: PermissionRequest[] = [];
  const history: Message[] = [];
  await runLoop(history, textMessage("user", "run everything"), {
    provider,
    tools: kernel.tools,
    permission: new PermissionEngine({
      mode: "ask",
      decider: {
        ask: async (req) => {
          requests.push(req);
          return "allow";
        },
      },
      audit: (entry) => audit.push(entry),
    }),
    systemPrompt: "s",
    workspaceRoot: "/tmp/ws",
    onEvent: (e) => events.push(e),
  });

  return {
    history,
    events,
    audit,
    requests,
    raws: Object.fromEntries(
      Object.entries(tools).map(([name, t]) => [name, (t as { raw: Array<Record<string, unknown>> }).raw]),
    ),
    persistCalls,
  };
}

describe("tool args redaction (persisted vs raw)", () => {
  it("execute receives raw args; secrets appear nowhere persisted", async () => {
    const run = await runWithAllTools();

    // Every tool executed exactly once, with the RAW values.
    expect(run.raws.Write[0].content).toBe(`token=${SECRETS.write}`);
    expect(run.raws.Edit[0].new_string).toBe(`new ${SECRETS.edit}`);
    expect(run.raws.Bash[0].command).toBe(`deploy --token=${SECRETS.bash}`);
    expect(run.raws["mcp__ci__deploy"][0].apiKey).toBe(SECRETS.mcp);
    expect(run.raws.Task[0].prompt).toBe(`use ${SECRETS.task}`);
    expect(run.raws.BrowserNavigate[0].url).toContain(SECRETS.browser);

    // History, events, permission requests, audit and transcript are all clean.
    const surfaces: Array<[string, unknown]> = [
      ["history", run.history],
      ["events", run.events],
      ["permission requests", run.requests],
      ["audit", run.audit],
      ["transcript", toTranscript(run.history)],
    ];
    for (const secret of ALL_SECRETS) {
      for (const [name, surface] of surfaces) {
        expect(JSON.stringify(surface), `${name} must not contain ${secret}`).not.toContain(secret);
      }
    }

    // The persisted shapes carry hashes/lengths, not content.
    const writeCall = run.history
      .flatMap((m) => m.parts)
      .find((p) => p.type === "toolCall" && p.toolName === "Write");
    expect(writeCall && writeCall.type === "toolCall" && writeCall.args).toMatchObject({
      path: "notes.txt",
      contentLength: `token=${SECRETS.write}`.length,
      contentSha256: sha256Hex(`token=${SECRETS.write}`),
    });

    const bashCall = run.history
      .flatMap((m) => m.parts)
      .find((p) => p.type === "toolCall" && p.toolName === "Bash");
    expect(bashCall && bashCall.type === "toolCall" && bashCall.args).toMatchObject({
      command: "deploy",
      commandSha256: sha256Hex(`deploy --token=${SECRETS.bash}`),
    });

    const mcpCall = run.history
      .flatMap((m) => m.parts)
      .find((p) => p.type === "toolCall" && p.toolName === "mcp__ci__deploy");
    expect(mcpCall && mcpCall.type === "toolCall" && mcpCall.args).toMatchObject({
      server: "ci",
      tool: "deploy",
      params: ["apiKey"],
    });

    const taskCall = run.history
      .flatMap((m) => m.parts)
      .find((p) => p.type === "toolCall" && p.toolName === "Task");
    expect(taskCall && taskCall.type === "toolCall" && taskCall.args).toMatchObject({
      agentType: "general",
      promptSha256: sha256Hex(`use ${SECRETS.task}`),
    });

    const browserCall = run.history
      .flatMap((m) => m.parts)
      .find((p) => p.type === "toolCall" && p.toolName === "BrowserNavigate");
    expect(browserCall && browserCall.type === "toolCall" && browserCall.args).toMatchObject({
      url: "https://example.com/path",
    });
  });

  it("permission requests and audit carry canonical resources, never raw args", async () => {
    const run = await runWithAllTools();

    expect(run.requests.map((r) => `${r.toolName}:${r.resource.action}:${r.resource.kind}:${r.resource.scope}`))
      .toEqual([
        "Write:write:path:notes.txt",
        "Edit:write:path:notes.txt",
        "Bash:execute:command:deploy",
        "mcp__ci__deploy:call:mcp:ci/deploy",
        "Task:spawn:agent:general",
        "BrowserNavigate:navigate:url:https://example.com/path",
      ]);
    expect(run.audit).toHaveLength(6);
    for (const entry of run.audit) {
      expect(entry.request.args).toBeDefined();
      expect(JSON.stringify(entry.request.resource)).not.toContain("SECRET");
    }
  });

  it("persistArgs runs exactly once per invocation despite history/event/request/audit reuse", async () => {
    const run = await runWithAllTools();
    expect(run.persistCalls).toEqual({
      Write: 1,
      Edit: 1,
      Bash: 1,
      "mcp__ci__deploy": 1,
      Task: 1,
      BrowserNavigate: 1,
    });
  });

  it("a validateArgs failure becomes an error result; the tool never executes", async () => {
    const executed: Array<Record<string, unknown>> = [];
    const tool: Tool = {
      name: "Strict",
      description: "strict",
      readOnly: false,
      parameters: { type: "object" },
      async validateArgs(args) {
        if (typeof args.path !== "string") throw new Error("Strict 需要 path");
      },
      permissionResource: () => ({ action: "read", kind: "path", scope: "x" }),
      persistArgs: () => ({}),
      async execute(args) {
        executed.push(args);
        return { content: "never" };
      },
    };
    let turn = 0;
    const provider: Provider = {
      id: "scripted",
      async *chat(): AsyncIterable<Delta> {
        turn += 1;
        if (turn === 1) {
          yield { type: "toolCall", id: "c1", toolName: "Strict", args: { path: 42 } };
        } else {
          yield { type: "text", text: "handled" };
        }
      },
    };
    const kernel = new Context();
    await kernel.plugin(ToolsPlugin);
    kernel.tools.register(tool);
    const events: HarnessEvent[] = [];
    const history: Message[] = [];
    await runLoop(history, textMessage("user", "go"), {
      provider,
      tools: kernel.tools,
      permission: new PermissionEngine({ mode: "auto", decider: { ask: async () => "deny" } }),
      systemPrompt: "s",
      workspaceRoot: "/tmp/ws",
      onEvent: (e) => events.push(e),
    });

    expect(executed).toHaveLength(0);
    const result = history
      .flatMap((m) => m.parts)
      .find((p) => p.type === "toolResult") as { isError?: boolean; content: string };
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Strict 需要 path");
  });

  it("raw args are not leaked into history even when a tool throws during preparation", async () => {
    const tool: Tool = {
      name: "Broken",
      description: "broken",
      readOnly: false,
      parameters: { type: "object" },
      permissionResource: () => {
        throw new Error("resource boom");
      },
      persistArgs: () => ({}),
      async execute() {
        return { content: "never" };
      },
    };
    let turn = 0;
    const provider: Provider = {
      id: "scripted",
      async *chat(): AsyncIterable<Delta> {
        turn += 1;
        if (turn === 1) {
          yield { type: "toolCall", id: "c1", toolName: "Broken", args: { password: "PREP-SECRET-11" } };
        } else {
          yield { type: "text", text: "handled" };
        }
      },
    };
    const kernel = new Context();
    await kernel.plugin(ToolsPlugin);
    kernel.tools.register(tool);
    const history: Message[] = [];
    await runLoop(history, textMessage("user", "go"), {
      provider,
      tools: kernel.tools,
      permission: new PermissionEngine({ mode: "auto", decider: { ask: async () => "deny" } }),
      systemPrompt: "s",
      workspaceRoot: "/tmp/ws",
      onEvent: () => {},
    });

    expect(JSON.stringify(history)).not.toContain("PREP-SECRET-11");
    const result = history
      .flatMap((m) => m.parts)
      .find((p) => p.type === "toolResult") as { isError?: boolean; content: string };
    expect(result.isError).toBe(true);
    expect(result.content).toContain("resource boom");
  });
});

describe("persistence-safe helpers", () => {
  it("redactCommand keeps only a command-like program word", () => {
    expect(redactCommand("npm test -- -u")).toBe("npm");
    expect(redactCommand("  git   status")).toBe("git");
    expect(redactCommand("node ./scripts/secret-run.js")).toBe("node");
    expect(redactCommand("SK-VERYLONGSECRETVALUE1234567890 run")).toBe("[redacted]");
    expect(redactCommand("")).toBe("[redacted]");
    expect(redactCommand("echo secret-token-value")).not.toContain("secret");
  });

  it("redactCommandSummary keeps program word plus shape-legal subcommands only", () => {
    expect(redactCommandSummary("npm test -- -u")).toBe("npm test");
    expect(redactCommandSummary("npm run build")).toBe("npm run build");
    expect(redactCommandSummary(`deploy --token=${SECRETS.bash}`)).toBe("deploy");
    expect(redactCommandSummary(`send ${SECRETS.bash}`)).toBe("send");
    expect(redactCommandSummary("--flagged npm test")).toBe("[redacted]");
    expect(redactCommandSummary("")).toBe("[redacted]");
  });

  it("redactUrl strips user-info, query and fragment; fails closed on garbage", () => {
    expect(redactUrl("https://user:pass@example.com/path?q=1#frag")).toBe("https://example.com/path");
    expect(redactUrl("file:///workspaces/secret/dir/")).toBe("file:///workspaces/secret/dir/");
    expect(redactUrl("not a url")).toBe("[invalid-url]");
  });

  it("sha256Hex produces stable lowercase hex digests", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abd")).not.toBe(sha256Hex("abc"));
  });
});
