import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessPlugin, Skill } from "@innocencecode/harness-core";

export interface ParsedSkillFile {
  name: string;
  description: string;
  body: string;
}

/**
 * Parses a SKILL.md file: `---`-delimited frontmatter with simple
 * `key: value` lines (name, description), body after the closing fence.
 */
export function parseSkillMarkdown(raw: string): ParsedSkillFile | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return null;
  const frontmatter = match[1];
  const body = match[2];
  const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
  if (!name || !description) return null;
  return { name, description, body: body.trim() };
}

async function loadSkillFrom(dir: string, entry: string): Promise<Skill | null> {
  const skillPath = path.join(dir, entry, "SKILL.md");
  const file = path.join(dir, entry);
  const target = await fs.stat(file).catch(() => null);
  if (!target) return null;
  const rawPath = target.isDirectory() ? skillPath : file;
  const raw = await fs.readFile(rawPath, "utf8").catch(() => null);
  if (raw === null) return null;
  const parsed = parseSkillMarkdown(raw);
  if (!parsed) return null;
  return {
    name: parsed.name,
    description: parsed.description,
    loadBody: async () => parsed.body,
  };
}

export interface SkillsPluginOptions {
  /** Directories to scan; each subdirectory (or *.md file) may hold a SKILL.md. */
  dirs: string[];
}

/** Scans skill directories at activation; registers every parseable skill. */
export const skillsPlugin = (options: SkillsPluginOptions): HarnessPlugin => ({
  name: "plugin-skills",
  async activate(ctx) {
    for (const dir of options.dirs) {
      let entries: string[] = [];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue; // missing dir is normal (no skills yet)
      }
      for (const entry of entries) {
        const skill = await loadSkillFrom(dir, entry);
        if (skill) {
          try {
            ctx.registerSkill(skill);
            ctx.log("info", `skill loaded: ${skill.name}`);
          } catch {
            // duplicate name across dirs — first one wins
          }
        }
      }
    }
  },
});
