import type { Skill } from "@innocencecode/harness-skills";
import { Context } from "@innocencecode/kernel";
import {
  SystemPromptPlugin,
  type SystemPromptService,
} from "@innocencecode/harness-system-prompt";
import { describe, expect, it } from "vitest";

// Mirrors harness-tools' test setup: load the plugin into a fresh kernel
// context; `ctx.systemPrompt` is live while the plugin fiber is active.
async function withPrompt(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(SystemPromptPlugin);
  return ctx;
}

function skill(name: string, description: string): Skill {
  return { name, description, loadBody: async () => "" };
}

// Byte-for-byte equivalence anchors against the previous private
// AgentSession.buildSystemPrompt (harness-core session.ts:169-176):
// no registered section may change any byte of its output.
describe("build equals the previous buildSystemPrompt output (byte anchors)", () => {
  it("base + skills index, single skill", async () => {
    const ctx = await withPrompt();
    ctx.systemPrompt.setBase("基础提示");
    expect(ctx.systemPrompt.build([skill("review", "代码审查指南")])).toBe(
      "基础提示\n\n可用技能（用户以 /名称 调用；相关时你也可以建议）：\n- review: 代码审查指南",
    );
  });

  it("base + skills index, multiple skills in registration order", async () => {
    const ctx = await withPrompt();
    ctx.systemPrompt.setBase("base");
    expect(
      ctx.systemPrompt.build([skill("review", "代码审查指南"), skill("plan", "计划指南")]),
    ).toBe(
      "base\n\n可用技能（用户以 /名称 调用；相关时你也可以建议）：\n- review: 代码审查指南\n- plan: 计划指南",
    );
  });

  it("returns the base unchanged when no skill is registered", async () => {
    const ctx = await withPrompt();
    ctx.systemPrompt.setBase("基础提示");
    expect(ctx.systemPrompt.build([])).toBe("基础提示");
  });

  it("keeps an empty prompt empty with no sections and no skills", async () => {
    const ctx = await withPrompt();
    expect(ctx.systemPrompt.build([])).toBe("");
  });

  it("appends the skills index to the system prompt (session.test.ts anchor)", async () => {
    const ctx = await withPrompt();
    ctx.systemPrompt.setBase("base");
    const systems: string[] = [ctx.systemPrompt.build([skill("review", "代码审查指南")])];
    expect(systems[0]).toContain("代码审查指南");
  });
});

describe("setBase", () => {
  it("defaults to an empty base prompt", async () => {
    const ctx = await withPrompt();
    expect(ctx.systemPrompt.build([])).toBe("");
  });

  it("replaces the base", async () => {
    const ctx = await withPrompt();
    ctx.systemPrompt.setBase("first");
    ctx.systemPrompt.setBase("second");
    expect(ctx.systemPrompt.build([])).toBe("second");
  });

  it("resets the base on undefined", async () => {
    const ctx = await withPrompt();
    ctx.systemPrompt.setBase("first");
    ctx.systemPrompt.setBase(undefined);
    expect(ctx.systemPrompt.build([])).toBe("");
  });
});

describe("registerSection", () => {
  it("appends sections after the base in ascending order", async () => {
    const ctx = await withPrompt();
    ctx.systemPrompt.setBase("base");
    ctx.systemPrompt.registerSection({ id: "agents", order: 20, render: () => "agent 段" });
    ctx.systemPrompt.registerSection({ id: "early", order: 10, render: () => "早段" });
    expect(ctx.systemPrompt.build([])).toBe("base\n\n早段\n\nagent 段");
  });

  it("keeps registration order for equal order values", async () => {
    const ctx = await withPrompt();
    ctx.systemPrompt.setBase("base");
    ctx.systemPrompt.registerSection({ id: "a", order: 10, render: () => "A" });
    ctx.systemPrompt.registerSection({ id: "b", order: 10, render: () => "B" });
    expect(ctx.systemPrompt.build([])).toBe("base\n\nA\n\nB");
  });

  it("skips sections that render to an empty string", async () => {
    const ctx = await withPrompt();
    ctx.systemPrompt.setBase("base");
    ctx.systemPrompt.registerSection({ id: "empty", order: 0, render: () => "" });
    ctx.systemPrompt.registerSection({ id: "kept", order: 1, render: () => "kept" });
    expect(ctx.systemPrompt.build([])).toBe("base\n\nkept");
  });

  it("places the skills index after every registered section", async () => {
    const ctx = await withPrompt();
    ctx.systemPrompt.setBase("base");
    ctx.systemPrompt.registerSection({ id: "agents", order: 10, render: () => "agent 段" });
    expect(ctx.systemPrompt.build([skill("review", "代码审查指南")])).toBe(
      "base\n\nagent 段\n\n可用技能（用户以 /名称 调用；相关时你也可以建议）：\n- review: 代码审查指南",
    );
  });

  it("rejects duplicate section ids", async () => {
    const ctx = await withPrompt();
    ctx.systemPrompt.registerSection({ id: "dup", order: 0, render: () => "x" });
    expect(() =>
      ctx.systemPrompt.registerSection({ id: "dup", order: 1, render: () => "y" }),
    ).toThrow("duplicate prompt section registration: dup");
  });
});

describe("system-prompt service lifecycle on the kernel", () => {
  it("carries the spine plugin name \"harness-system-prompt\"", () => {
    expect(SystemPromptPlugin.name).toBe("harness-system-prompt");
  });

  it("publishes the service under \"systemPrompt\" while its fiber is active", async () => {
    const ctx = await withPrompt();
    expect((ctx as { systemPrompt?: SystemPromptService }).systemPrompt).toBeDefined();
    ctx.systemPrompt.setBase("live");
    expect(ctx.systemPrompt.build([])).toBe("live");
  });

  it("withdraws the service when the plugin fiber is disposed", async () => {
    const ctx = new Context();
    const fiber = await ctx.plugin(SystemPromptPlugin);
    const service = ctx.systemPrompt;
    expect((ctx as { systemPrompt?: SystemPromptService }).systemPrompt).toBeDefined();
    await fiber.dispose();
    // The withdraw handle returned by `apply` removed the context property;
    // the detached service object stays usable.
    expect((ctx as { systemPrompt?: SystemPromptService }).systemPrompt).toBeUndefined();
    expect(() => service.setBase("detached")).not.toThrow();
  });
});
