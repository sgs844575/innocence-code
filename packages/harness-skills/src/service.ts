import type { Context } from "@innocencecode/kernel";
import { buildSkillIndex, type SkillIndex } from "./skill-index";
import type { Skill } from "./skill";

// Services are typed on `Context` through declaration merging by their
// publisher (kernel ServiceTable contract). The member is live only while
// the SkillsPlugin fiber publishing it is active; before load and after
// its unwind the property is absent at runtime.
declare module "@innocencecode/kernel" {
  interface Context {
    skills: SkillsService;
  }
}

/** Skills registration surface published by {@link SkillsPlugin} under "skills". */
export interface SkillsService {
  /**
   * Registers a skill; duplicate names are rejected (the skill
   * registration gate: a duplicate never overwrites the earlier entry).
   */
  register(skill: Skill): void;
  get(name: string): Skill | undefined;
  /** Registered skills in registration order. */
  all(): readonly Skill[];
  /** Rendered skills index (descriptions only) for the system prompt. */
  index(): SkillIndex;
}

/**
 * Skills spine service plugin. `apply` publishes a {@link SkillsService}
 * under "skills" on the scope owning the plugin context and returns the
 * withdraw handle, so the service disappears when the plugin fiber unwinds.
 */
export const SkillsPlugin: { name: "harness-skills"; apply(ctx: Context): () => void } = {
  name: "harness-skills",
  apply(ctx) {
    const registeredSkills = new Map<string, Skill>();

    const service: SkillsService = {
      register: (skill) => {
        if (registeredSkills.has(skill.name)) {
          throw new Error(`duplicate skill registration: ${skill.name}`);
        }
        registeredSkills.set(skill.name, skill);
      },
      get: (name) => registeredSkills.get(name),
      all: () => [...registeredSkills.values()],
      index: () => buildSkillIndex([...registeredSkills.values()]),
    };

    return ctx.provide("skills", service);
  },
};
