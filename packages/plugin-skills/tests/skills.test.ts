import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession, PluginRegistry, type Delta, type Provider } from "@innocencecode/harness-core";
import { parseSkillMarkdown, skillsPlugin } from "../src";

let skillsDir: string;
beforeAll(async () => {
  skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-skills-"));
  await fs.mkdir(path.join(skillsDir, "review"), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir, "review", "SKILL.md"),
    "---\nname: review\ndescription: 代码审查指南\n---\n\n审查正文：先看测试再看实现。",
    "utf8",
  );
  await fs.writeFile(
    path.join(skillsDir, "broken.md"),
    "没有 frontmatter 的文件应被忽略",
    "utf8",
  );
});
afterAll(async () => {
  await fs.rm(skillsDir, { recursive: true, force: true });
});

describe("parseSkillMarkdown", () => {
  it("parses frontmatter and body", () => {
    const parsed = parseSkillMarkdown(
      "---\nname: a\ndescription: b\n---\n\n正文",
    );
    expect(parsed).toEqual({ name: "a", description: "b", body: "正文" });
  });

  it("rejects files without complete frontmatter", () => {
    expect(parseSkillMarkdown("just text")).toBeNull();
    expect(parseSkillMarkdown("---\nname: a\n---\nbody")).toBeNull();
    expect(parseSkillMarkdown("---\ndescription: b\n---\nbody")).toBeNull();
  });
});

describe("skillsPlugin", () => {
  it("registers parseable skills and skips the rest", async () => {
    const reg = new PluginRegistry();
    await reg.load([skillsPlugin({ dirs: [skillsDir, path.join(skillsDir, "missing")] })]);
    expect([...reg.skills.keys()]).toEqual(["review"]);
  });

  it("session injects the index and expands /skill input with the body", async () => {
    const systems: string[] = [];
    const provider: Provider = {
      id: "echo",
      async *chat(req): AsyncIterable<Delta> {
        systems.push(req.system);
        yield { type: "text", text: "ok" };
      },
    };
    const session = await AgentSession.create({
      plugins: [skillsPlugin({ dirs: [skillsDir] })],
      provider,
      workspaceRoot: "D:/tmp",
      permission: { mode: "auto", decider: { ask: async () => "deny" } },
    });
    await session.run("/review 请检查这段代码");
    expect(systems[0]).toContain("review: 代码审查指南");
    const firstUser = session.history[0].parts[0];
    expect(firstUser).toMatchObject({
      type: "text",
      text: expect.stringContaining("审查正文：先看测试再看实现"),
    });
  });
});
