import type { Skill } from "./skill";

/**
 * Rendered skills index: one `- name: description` line per skill in
 * registration order, joined by newlines. Empty when no skill is
 * registered.
 */
export type SkillIndex = string;

/** Builds the rendered skills index table (descriptions only). */
export function buildSkillIndex(skills: readonly Skill[]): SkillIndex {
  return skills
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");
}

/**
 * Skills index table appended to the system prompt (descriptions only).
 */
export function appendSkillIndex(systemPrompt: string, skills: readonly Skill[]): string {
  if (skills.length === 0) return systemPrompt;
  return `${systemPrompt}\n\n可用技能（用户以 /名称 调用；相关时你也可以建议）：\n${buildSkillIndex(skills)}`;
}
