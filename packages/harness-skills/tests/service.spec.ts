import { Context } from "@innocencecode/kernel";
import {
  SkillsPlugin,
  type Skill,
  type SkillsService,
} from "@innocencecode/harness-skills";
import { describe, expect, expectTypeOf, it } from "vitest";

// Mirrors harness-tools' test setup: load the plugin into a fresh kernel
// context; `ctx.skills` is live while the plugin fiber is active.
async function withSkills(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(SkillsPlugin);
  return ctx;
}

describe("skill registration", () => {
  it("exposes exactly what was registered through the gate", async () => {
    const ctx = await withSkills();
    ctx.skills.register({ name: "sk", description: "d", loadBody: async () => "" });
    expect(ctx.skills.get("sk")?.name).toBe("sk");
  });

  it("rejects duplicate skill names", async () => {
    const ctx = await withSkills();
    ctx.skills.register({ name: "Twin", description: "d", loadBody: async () => "" });
    expect(() =>
      ctx.skills.register({ name: "Twin", description: "d", loadBody: async () => "" }),
    ).toThrow("duplicate skill registration: Twin");
    expect(ctx.skills.get("Twin")?.name).toBe("Twin");
  });

  it("lists skills in registration order", async () => {
    const ctx = await withSkills();
    ctx.skills.register({ name: "a", description: "da", loadBody: async () => "" });
    ctx.skills.register({ name: "b", description: "db", loadBody: async () => "" });
    expect(ctx.skills.all().map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("all exposes a readonly view (type-level gate)", async () => {
    const ctx = await withSkills();
    expectTypeOf(ctx.skills.all()).toEqualTypeOf<readonly Skill[]>();
  });

  it("index renders one description line per registered skill", async () => {
    const ctx = await withSkills();
    expect(ctx.skills.index()).toBe("");
    ctx.skills.register({
      name: "review",
      description: "代码审查指南",
      loadBody: async () => "审查正文内容",
    });
    ctx.skills.register({ name: "plan", description: "计划指南", loadBody: async () => "" });
    expect(ctx.skills.index()).toBe("- review: 代码审查指南\n- plan: 计划指南");
  });
});

describe("skills service lifecycle on the kernel", () => {
  it("carries the spine plugin name \"harness-skills\"", () => {
    expect(SkillsPlugin.name).toBe("harness-skills");
  });

  it("publishes the service under \"skills\" while its fiber is active", async () => {
    const ctx = await withSkills();
    expect((ctx as { skills?: SkillsService }).skills).toBeDefined();
    ctx.skills.register({ name: "sk", description: "d", loadBody: async () => "" });
    expect(ctx.skills.get("sk")?.name).toBe("sk");
  });

  it("withdraws the service when the plugin fiber is disposed", async () => {
    const ctx = new Context();
    const fiber = await ctx.plugin(SkillsPlugin);
    const service = ctx.skills;
    ctx.skills.register({ name: "sk", description: "d", loadBody: async () => "" });
    await fiber.dispose();
    // The withdraw handle returned by `apply` removed the context property;
    // the detached service object stays inert but usable.
    expect((ctx as { skills?: SkillsService }).skills).toBeUndefined();
    expect(() =>
      service.register({ name: "late", description: "d", loadBody: async () => "" }),
    ).not.toThrow();
  });
});
