import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "@innocencecode/kernel";
import type { Skill } from "@innocencecode/harness-skills";
import type { Message, MessagePart } from "@innocencecode/harness-session";

// ctx.logger 的类型可见性：kernel-logger 不自带 Context 增强，这里按
// session 组合侧（harness-electron/session-kernel）的同一声明就地合并（成员
// 类型逐字一致，同程序内合并合法），包自身不依赖宿主适配层。
declare module "@innocencecode/kernel" {
  interface Context {
    logger: import("@innocencecode/kernel-logger").LoggerService;
  }
}

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

/** The skills service face the expansion needs (subset of the spine face). */
interface SkillsLookup {
  get(name: string): Skill | undefined;
  all(): readonly Skill[];
}

/**
 * Pipeline order of the expansion processor: strictly ahead of the
 * conventionally-numbered processors (hosts register theirs at 0), so
 * downstream processors see the expanded text — the pre-migration session
 * expanded user input before running any processor.
 */
const SKILL_EXPANSION_ORDER = -1000;

/** Expands "/skillname ..." input by loading the skill body as context. */
async function expandUserText(text: string, skills: SkillsLookup): Promise<string> {
  const match = /^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/.exec(text.trim());
  if (!match) return text;
  const skill = skills.get(match[1]);
  if (!skill) return text;
  const body = await skill.loadBody();
  return `[已加载技能 ${skill.name}]\n${body}\n\n[用户输入]\n${match[2]}`;
}

/**
 * Runs skill expansion over one message. Only the targeted text parts
 * change; every other part is kept as-is, in order.
 */
async function expandUserMessage(message: Message, skills: SkillsLookup): Promise<Message> {
  if (skills.all().length === 0) return message;
  const parts: MessagePart[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push({ type: "text", text: await expandUserText(part.text, skills) });
    } else {
      parts.push(part);
    }
  }
  return { role: message.role, parts };
}

/** Kernel-native skills plugin (name "skills"). */
export interface SkillsPlugin {
  readonly name: "skills";
  apply(ctx: Context): Promise<void>;
}

/**
 * Scans skill directories at apply time, registers every parseable skill on
 * the spine skills service, and registers the "/name" expansion message
 * processor (order first) on the session service — expansion runs over real
 * user input only, exactly like the pipeline-external pass it replaces.
 */
export function createSkillsPlugin(options: SkillsPluginOptions): SkillsPlugin {
  return {
    name: "skills",
    async apply(ctx) {
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
              ctx.skills.register(skill);
              ctx.logger.log("info", `[skills] skill loaded: ${skill.name}`);
            } catch {
              // duplicate name across dirs — first one wins
            }
          }
        }
      }
      ctx.session.registerProcessor({
        name: "skill-expansion",
        order: SKILL_EXPANSION_ORDER,
        process: (message) => expandUserMessage(message, ctx.skills),
      });
    },
  };
}
// Distribution default (kernel-loader unwrapExports convention): the factory,
// so a disk-loaded module resolves to the single entry point hosts configure.
export default createSkillsPlugin;
