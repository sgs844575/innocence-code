import { describe, expect, it } from "vitest";
import { AgentSession, type Delta, type HarnessPlugin, type Provider } from "../src";

function echoProvider(log: string[] = []): Provider {
  return {
    id: "echo",
    async *chat(req): AsyncIterable<Delta> {
      log.push(req.system);
      yield { type: "text", text: `echo:${req.messages.at(-1)?.parts[0] ?? ""}` };
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

  it("appends the skills index to the system prompt and expands /skill input", async () => {
    const systems: string[] = [];
    const provider: Provider = {
      id: "echo",
      async *chat(req): AsyncIterable<Delta> {
        systems.push(req.system);
        yield { type: "text", text: "ok" };
      },
    };
    const skillPlugin: HarnessPlugin = {
      name: "skills",
      activate(ctx) {
        ctx.registerSkill({
          name: "review",
          description: "代码审查指南",
          loadBody: async () => "审查正文内容",
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
      { toolName: "Read", args: {} },
      { readOnly: true },
    );
    expect(readAllow.via).toBe("allowRule");
    expect(asked).toBe(0);
  });
});
