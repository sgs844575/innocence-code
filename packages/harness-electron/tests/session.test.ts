// AgentSession behavior suite (moved here with the session family from the
// retired core package; assertions unchanged, imports re-pointed to
// the spine packages that own each type face).
import { describe, expect, it, vi } from "vitest";
import { AgentSession, staticSpineSuite, type HarnessPlugin, type SessionSpineSuite } from "../src";
import * as loopModule from "@innocencecode/harness-agent-loop";
import type { Delta, Provider } from "@innocencecode/harness-providers";
import type { ExecutionScope, Tool } from "@innocencecode/harness-tools";
import type { MessagePart } from "@innocencecode/harness-session";

function echoProvider(log: string[] = []): Provider {
  return {
    id: "echo",
    async *chat(req): AsyncIterable<Delta> {
      log.push(req.system);
      yield { type: "text", text: `echo:${req.messages.at(-1)?.parts[0] ?? ""}` };
    },
  };
}

function baseOptions() {
  return {
    provider: echoProvider(),
    workspaceRoot: "D:/tmp",
    permission: { mode: "auto" as const, decider: { ask: async () => "deny" as const } },
  };
}

interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ toolName: string; args?: Record<string, unknown> }>;
}

function scriptedProvider(turns: ScriptedTurn[]): Provider {
  let i = 0;
  return {
    id: "scripted",
    async *chat(): AsyncIterable<Delta> {
      // Cycles the script so consecutive runs replay the same turn sequence.
      const turn = turns[i % turns.length]!;
      i += 1;
      if (turn.text) yield { type: "text", text: turn.text };
      for (const [n, call] of (turn.toolCalls ?? []).entries()) {
        yield {
          type: "toolCall",
          id: `call_${i}_${n}`,
          toolName: call.toolName,
          args: call.args ?? {},
        };
      }
    },
  };
}

function toolsPlugin(tools: Tool[]): HarnessPlugin {
  return {
    name: "test-tools",
    activate(ctx) {
      for (const tool of tools) ctx.registerTool(tool);
    },
  };
}

function probeTool(spy: { calls: number } = { calls: 0 }): Tool {
  return {
    name: "Probe",
    description: "probe",
    readOnly: true,
    sideEffect: "none",
    parameters: { type: "object" },
    permissionResource: () => ({ action: "read", kind: "test", scope: "probe" }),
    persistArgs: (args) => ({ ...args }),
    async execute() {
      spy.calls += 1;
      return { content: "probe-done" };
    },
  };
}

describe("AgentSession", () => {
  it("loads plugins and resolves providerId from the registry", async () => {
    const plugin: HarnessPlugin = {
      name: "p",
      activate(ctx) {
        ctx.registerProvider(echoProvider());
      },
    };
    const session = await AgentSession.create({
      plugins: [plugin],
      providerId: "echo",
      workspaceRoot: "D:/tmp",
      permission: { mode: "auto", decider: { ask: async () => "deny" } },
    });
    const result = await session.run("你好");
    expect(result.finalText).toContain("echo:");
  });

  it("throws when the requested provider is missing", async () => {
    await expect(
      AgentSession.create({
        plugins: [],
        providerId: "nope",
        workspaceRoot: "D:/tmp",
        permission: { mode: "auto", decider: { ask: async () => "deny" } },
      }),
    ).rejects.toThrow("provider not found: nope");
  });

  it("resolves the sole registry provider when no explicit provider is given", async () => {
    const plugin: HarnessPlugin = {
      name: "p",
      activate(ctx) {
        ctx.registerProvider(echoProvider());
      },
    };
    const session = await AgentSession.create({
      plugins: [plugin],
      workspaceRoot: "D:/tmp",
      permission: { mode: "auto", decider: { ask: async () => "deny" } },
    });
    const result = await session.run("你好");
    expect(result.finalText).toContain("echo:");
  });

  it("rejects an id-less session when the registry holds more than one provider (no silent pick)", async () => {
    const plugin: HarnessPlugin = {
      name: "p",
      activate(ctx) {
        ctx.registerProvider(echoProvider());
        ctx.registerProvider({ id: "echo-2", async *chat() {} });
      },
    };
    await expect(
      AgentSession.create({
        plugins: [plugin],
        workspaceRoot: "D:/tmp",
        permission: { mode: "auto", decider: { ask: async () => "deny" } },
      }),
    ).rejects.toThrow("no provider configured");
  });

  it("still rejects a provider-less session with no registered provider", async () => {
    await expect(
      AgentSession.create({
        plugins: [],
        workspaceRoot: "D:/tmp",
        permission: { mode: "auto", decider: { ask: async () => "deny" } },
      }),
    ).rejects.toThrow("no provider configured");
  });

  it("create failures after plugin load dispose the already-activated plugins", async () => {
    const events: string[] = [];
    await expect(
      AgentSession.create({
        plugins: [
          {
            name: "leaky",
            activate() {},
            async dispose() {
              events.push("disposed-leaky");
            },
          },
        ],
        providerId: "missing-provider",
        workspaceRoot: "D:/tmp",
        permission: { mode: "auto", decider: { ask: async () => "deny" } },
      }),
    ).rejects.toThrow("provider not found: missing-provider");
    expect(events).toEqual(["disposed-leaky"]);
  });

  it("passes validateResource and audit through to the session-built engine", async () => {
    const audited: Array<{ toolName: string; scope: string }> = [];
    const validated: string[] = [];
    const session = await AgentSession.create({
      plugins: [],
      provider: echoProvider(),
      workspaceRoot: "D:/tmp",
      permission: {
        mode: "ask",
        decider: { ask: async () => "allow" },
        validateResource: (resource) => {
          validated.push(resource.scope);
        },
        audit: (entry) => {
          audited.push({
            toolName: entry.request.toolName,
            scope: entry.request.resource.scope,
          });
        },
      },
    });

    const resolution = await session.permission.resolve(
      { toolName: "Read", resource: { action: "read", kind: "path", scope: "a.ts" }, args: {} },
      { readOnly: true, sideEffect: "none" },
    );
    expect(resolution.decision).toBe("allow");
    expect(validated).toEqual(["a.ts"]); // hard validation is installed and consulted
    expect(audited).toEqual([{ toolName: "Read", scope: "a.ts" }]); // audit entries flow
  });

  it("hard resource validation passed via options rejects calls in any mode", async () => {
    const session = await AgentSession.create({
      plugins: [],
      provider: echoProvider(),
      workspaceRoot: "D:/tmp",
      permission: {
        mode: "full",
        decider: { ask: async () => "allow" },
        validateResource: (resource) => {
          if (resource.kind === "url") throw new Error("blocked resource");
        },
      },
    });
    await expect(
      session.permission.resolve(
        { toolName: "BrowserNavigate", resource: { action: "navigate", kind: "url", scope: "file:///x" }, args: {} },
        { readOnly: false, sideEffect: "unknown" },
      ),
    ).rejects.toThrow("blocked resource");
  });

  it("appends the skills index to the system prompt and expands /skill input", async () => {
    const systems: string[] = [];
    const provider: Provider = {
      id: "echo",
      async *chat(req): AsyncIterable<Delta> {
        systems.push(req.system);
        yield { type: "text", text: "ok" };
      },
    };
    // "/name" 展开已迁入 plugin-skills（首序 MessageProcessor）；此处内联同
    // 语义 processor，经 adapter 装载路径继续锚定 session 行为（技能索引注入
    // + processor 管线在进入 loop 前运行）。展开语义本体由 plugin-skills
    // 用例钉死；T12 收敛时统一。
    const skillPlugin: HarnessPlugin = {
      name: "skills",
      activate(ctx) {
        const review = {
          name: "review",
          description: "代码审查指南",
          loadBody: async () => "审查正文内容",
        };
        ctx.registerSkill(review);
        ctx.registerMessageProcessor({
          name: "skill-expansion",
          order: -1000,
          async process(message) {
            const parts: MessagePart[] = [];
            for (const part of message.parts) {
              if (part.type !== "text") {
                parts.push(part);
                continue;
              }
              const match = /^\/review\s*([\s\S]*)$/.exec(part.text.trim());
              parts.push({
                type: "text" as const,
                text: match
                  ? `[已加载技能 review]\n${await review.loadBody()}\n\n[用户输入]\n${match[1]}`
                  : part.text,
              });
            }
            return { role: message.role, parts };
          },
        });
      },
    };
    const session = await AgentSession.create({
      plugins: [skillPlugin],
      provider,
      workspaceRoot: "D:/tmp",
      permission: { mode: "auto", decider: { ask: async () => "deny" } },
    });
    await session.run("/review 请检查这段代码");
    expect(systems[0]).toContain("代码审查指南");
    expect(session.history[0].parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("审查正文内容"),
    });
  });

  it("dispose aborts the active run and disposes plugins after it settles", async () => {
    const events: string[] = [];
    let chatStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      chatStarted = resolve;
    });
    const plugin: HarnessPlugin = {
      name: "lifecycle",
      activate() {},
      async dispose() {
        events.push("disposed");
      },
    };
    const provider: Provider = {
      id: "hang",
      async *chat(req) {
        events.push("chat");
        chatStarted();
        await new Promise<never>((_, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (req.signal?.aborted) abort();
          else req.signal?.addEventListener("abort", abort, { once: true });
        });
        yield { type: "text", text: "never" };
      },
    };
    const session = await AgentSession.create({
      plugins: [plugin],
      provider,
      workspaceRoot: "D:/tmp",
      permission: { mode: "auto", decider: { ask: async () => "deny" } },
    });

    const runPromise = session.run("hello");
    await started;
    await session.dispose();
    const summary = await runPromise;

    expect(summary.aborted).toBe(true);
    expect(events).toEqual(["chat", "disposed"]);
  });

  it("dispose during message processing waits for the run instead of releasing the registry early", async () => {
    const events: string[] = [];
    let processorStarted!: () => void;
    let releaseProcessor!: () => void;
    const started = new Promise<void>((resolve) => {
      processorStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseProcessor = resolve;
    });
    const session = await AgentSession.create({
      plugins: [
        {
          name: "slow-processor",
          activate(ctx) {
            ctx.registerMessageProcessor({
              name: "slow",
              order: 0,
              async process(message) {
                processorStarted();
                await gate;
                events.push("processor-done");
                return message;
              },
            });
          },
        },
        {
          name: "lifecycle",
          activate() {},
          async dispose() {
            events.push("registry-disposed");
          },
        },
      ],
      provider: echoProvider(),
      workspaceRoot: "D:/tmp",
      permission: { mode: "auto", decider: { ask: async () => "deny" } },
    });

    const runPromise = session.run("hello");
    await started; // the run is parked inside its entry-phase processor await
    const disposePromise = session.dispose();
    // The registry must still be alive: dispose parks on the in-flight run
    // (which was published synchronously) instead of disposing underneath it.
    expect(events).toEqual([]);
    releaseProcessor();

    const summary = await runPromise;
    await disposePromise;
    expect(summary.aborted).toBe(true); // settles aborted, never drives a released registry
    expect(events).toEqual(["processor-done", "registry-disposed"]);
  });

  it("run() after dispose rejects with 会话已释放", async () => {
    const session = await AgentSession.create({ plugins: [], ...baseOptions() });
    await session.run("第一次");
    await session.dispose();

    await expect(session.run("再来一次")).rejects.toThrow("会话已释放");
    // The rejected run never entered the history.
    expect(session.history).toHaveLength(2);
  });

  it("dispose is idempotent and repeated dispose stays a no-op", async () => {
    let disposed = 0;
    const plugin: HarnessPlugin = {
      name: "count",
      activate() {},
      async dispose() {
        disposed += 1;
      },
    };
    const session = await AgentSession.create({
      plugins: [plugin],
      ...baseOptions(),
    });
    await session.dispose();
    await session.dispose();
    expect(disposed).toBe(1);
  });

  it("applies project permission config rules", async () => {
    let asked = 0;
    const session = await AgentSession.create({
      plugins: [],
      provider: echoProvider(),
      workspaceRoot: "D:/tmp",
      permission: {
        mode: "ask",
        decider: {
          ask: async () => {
            asked += 1;
            return "deny";
          },
        },
        projectConfig: { allow: ["Read"] },
      },
    });
    const readAllow = await session.permission.resolve(
      { toolName: "Read", resource: { action: "read", kind: "path", scope: "." }, args: {} },
      { readOnly: true, sideEffect: "none" },
    );
    expect(readAllow.via).toBe("allowRule");
    expect(asked).toBe(0);
  });

  it("processes a canonical user message before storing history", async () => {
    const session = await AgentSession.create({
      ...baseOptions(),
      plugins: [{
        name: "processor",
        activate(ctx) {
          ctx.registerMessageProcessor({
            name: "append",
            order: 0,
            async process(message) {
              return { ...message, parts: [...message.parts, { type: "text", text: " processed" }] };
            },
          });
        },
      }],
    });

    await session.run({ role: "user", parts: [{ type: "text", text: "input" }] });
    expect(session.history[0]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "input" }, { type: "text", text: " processed" }],
    });
  });

  it("converts a string input into a canonical user message before processing", async () => {
    const session = await AgentSession.create({
      ...baseOptions(),
      plugins: [{
        name: "processor",
        activate(ctx) {
          ctx.registerMessageProcessor({
            name: "append",
            order: 0,
            async process(message) {
              return { ...message, parts: [...message.parts, { type: "text", text: " processed" }] };
            },
          });
        },
      }],
    });

    await session.run("hi");
    expect(session.history[0]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "hi" }, { type: "text", text: " processed" }],
    });
  });

  it("rejects a non-user message input without touching history", async () => {
    const session = await AgentSession.create({ ...baseOptions(), plugins: [] });
    await expect(
      session.run({ role: "assistant", parts: [{ type: "text", text: "nope" }] }),
    ).rejects.toThrow(/user/);
    expect(session.history).toHaveLength(0);
  });

  it("runs message processors on real user input only, never on tool-result turns", async () => {
    const seenPartShapes: string[][] = [];
    const probe = probeTool();
    const session = await AgentSession.create({
      ...baseOptions(),
      provider: scriptedProvider([{ toolCalls: [{ toolName: "Probe" }] }, { text: "done" }]),
      plugins: [
        toolsPlugin([probe]),
        {
          name: "recorder",
          activate(ctx) {
            ctx.registerMessageProcessor({
              name: "rec",
              order: 0,
              async process(message) {
                seenPartShapes.push(message.parts.map((p) => p.type));
                return message;
              },
            });
          },
        },
      ],
    });

    await session.run("帮我查");
    // Exactly one processor pass over the real user input; the tool-result
    // user turn fed back by the loop never goes through processors.
    expect(seenPartShapes).toEqual([["text"]]);
  });

  it("mints a per-run scope inherited by every invocation and patchable via scopePatch", async () => {
    const probe = probeTool();
    const session = await AgentSession.create({
      ...baseOptions(),
      provider: scriptedProvider([{ toolCalls: [{ toolName: "Probe" }] }, { text: "done" }]),
      plugins: [toolsPlugin([probe])],
    });
    const scopes: ExecutionScope[] = [];
    session.registry.createContext("scope-spy", () => {}).registerToolMiddleware({
      name: "scope-spy",
      async execute(invocation, next) {
        scopes.push(invocation.scope);
        return next();
      },
    });

    await session.run("第一问", undefined, { taskId: "task-1" });
    await session.run("第二问", undefined, { taskId: "task-2" });

    expect(scopes).toHaveLength(2);
    for (const scope of scopes) {
      expect(scope.sessionId).toBe(session.sessionId);
      expect(scope.sessionId).toMatch(/^sess-/);
      expect(scope.routeId).toMatch(/^route-/);
      expect(scope.toolName).toBe("Probe");
    }
    expect(scopes[0]!.taskId).toBe("task-1");
    expect(scopes[1]!.taskId).toBe("task-2");
    expect(scopes[0]!.routeId).not.toBe(scopes[1]!.routeId); // fresh route per run
    expect(scopes[0]!.invocationId).not.toBe(scopes[1]!.invocationId); // fresh id per call
  });

  it("a child dispose failure never masks the child run's original error", async () => {
    const logs: Array<{ level: string; msg: string }> = [];
    const session = await AgentSession.create({
      plugins: [
        {
          // Inherited by the child: its run rejects with the processor error.
          name: "boom-processor",
          activate(ctx) {
            ctx.registerMessageProcessor({
              name: "boom",
              order: 0,
              async process() {
                throw new Error("run-boom");
              },
            });
          },
        },
      ],
      provider: echoProvider(),
      workspaceRoot: "D:/tmp",
      permission: { mode: "auto", decider: { ask: async () => "deny" } },
      logger: (level, msg) => logs.push({ level, msg }),
    });
    const disposeSpy = vi
      .spyOn(AgentSession.prototype, "dispose")
      .mockRejectedValue(new Error("dispose-boom"));
    try {
      await expect(
        session.spawner.run({ systemPrompt: "子", tools: "all", prompt: "去查" }),
      ).rejects.toThrow("run-boom");
    } finally {
      disposeSpy.mockRestore();
    }
    // The swallowed dispose failure is still reported through the logger.
    expect(logs).toContainEqual({ level: "error", msg: "subagent child dispose failed" });
  });

  it("loads a kernel-native plugin (apply) beside legacy plugins with the registry mirror intact", async () => {
    const nativeSpy = { calls: 0 };
    const legacySpy = { calls: 0 };
    const session = await AgentSession.create({
      ...baseOptions(),
      provider: scriptedProvider([
        { toolCalls: [{ toolName: "Probe" }, { toolName: "Legacy" }] },
        { text: "done" },
      ]),
      plugins: [
        {
          // Kernel-native shape: registers through the spine tools service;
          // the session composition routes it through the registry view.
          name: "native-tools",
          apply(ctx) {
            ctx.tools.register(probeTool(nativeSpy));
          },
        },
        toolsPlugin([{ ...probeTool(legacySpy), name: "Legacy" }]),
      ],
    });

    // Both plugin shapes land in the registry mirror (toolIndex adopt and
    // spawner selection read this surface — native mounts must not bypass it).
    expect([...session.registry.tools.keys()].sort()).toEqual(["Legacy", "Probe"]);

    // Both tools execute through the loop.
    await session.run("双轨装载");
    expect(nativeSpy.calls).toBe(1);
    expect(legacySpy.calls).toBe(1);
  });
});

describe("AgentSession injected scope", () => {
  it("mounts into a host-owned scope and unwinds it on dispose", async () => {
    const { Context, createScope } = await import("@innocencecode/kernel");
    const root = new Context();
    const scope = createScope(root);
    const cleaned: string[] = [];
    const probe: Tool = {
      name: "Probe",
      description: "探针",
      readOnly: true,
      sideEffect: "none",
      parameters: { type: "object", properties: {} },
      permissionResource: () => ({ action: "read", kind: "paths", scope: "x" }),
      persistArgs: () => ({}),
      execute: async () => ({ content: "ok" }),
    };
    const session = await AgentSession.create({
      ...baseOptions(),
      scope,
      plugins: [{
        name: "probe",
        apply(ctx) {
          ctx.tools.register(probe);
          ctx.effect(() => () => { cleaned.push("plugin"); }, "probe-cleanup");
        },
      }],
    });
    expect([...session.registry.tools.keys()]).toContain("Probe");
    // The session's publications shadow the root's names inside the scope
    // (session spine services) without leaking onto the host root.
    expect(scope.ctx.services.owns("tools")).toBe(true);
    expect(root.services.owns("tools")).toBe(false);

    await session.dispose();
    expect(cleaned).toEqual(["plugin"]);
    // The host root outlives the route scope; unwinding it is idempotent.
    await scope.dispose();
    await root.fiber.dispose();
  });
});

describe("AgentSession spine suite", () => {
  it("propagates the injected spine to spawned child sessions (one suite identity per process)", async () => {
    // Marker module: only sessions that mounted THIS suite build their run
    // loop through the recording createRunLoop (the static default would use
    // the unwrapped loopModule and record nothing).
    const loopBuilds: number[] = [];
    const markedLoop: typeof loopModule = {
      ...loopModule,
      createRunLoop: (deps) => {
        loopBuilds.push(1);
        return loopModule.createRunLoop(deps);
      },
    };
    const suite: SessionSpineSuite = { ...staticSpineSuite(), loop: markedLoop };

    const session = await AgentSession.create({
      plugins: [],
      provider: echoProvider(),
      workspaceRoot: "D:/tmp",
      permission: { mode: "auto", decider: { ask: async () => "deny" as const } },
      spine: suite,
    });
    expect(session.options.spine).toBe(suite); // parent mounted the injected suite
    expect(loopBuilds).toHaveLength(1); // ...and built its loop through the marker

    const result = await session.spawner.run({ systemPrompt: "子", tools: "all", prompt: "去查" });
    expect(result.finalText).toContain("echo:");
    // The spawned child session mounted the SAME injected suite (a second
    // marker build); before propagation it silently fell back to the static
    // default, splitting the process's spine module identities.
    expect(loopBuilds).toHaveLength(2);

    await session.dispose();
  });
});
