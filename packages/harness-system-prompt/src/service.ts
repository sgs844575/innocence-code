import { appendSkillIndex } from "@innocencecode/harness-skills";
import type { Skill } from "@innocencecode/harness-skills";
import type { Context } from "@innocencecode/kernel";

// Services are typed on `Context` through declaration merging by their
// publisher (kernel ServiceTable contract). The member is live only while
// the system-prompt plugin fiber publishing it is active; before load and
// after its unwind the property is absent at runtime.
declare module "@innocencecode/kernel" {
  interface Context {
    systemPrompt: SystemPromptService;
  }
}

/** Renderable prompt section appended after the base (e.g. an agents section). */
export interface PromptSection {
  id: string;
  order: number;
  render(): string;
}

/**
 * System-prompt spine service: owns the base prompt and ordered extra
 * sections, and assembles the final prompt as
 * base + registered sections (ascending `order`, registration order on
 * ties) + skills index (appendSkillIndex semantics). With no registered
 * section the output is byte-identical to the previous private
 * AgentSession.buildSystemPrompt.
 */
export interface SystemPromptService {
  setBase(prompt: string | undefined): void;
  registerSection(section: { id: string; order: number; render(): string }): void;
  /** Assembles base + registered sections + skills index. */
  build(skills: readonly Skill[]): string;
}

/**
 * System-prompt spine service plugin. `apply` publishes a
 * {@link SystemPromptService} under "systemPrompt" on the scope owning the
 * plugin context and returns the withdraw handle, so the service disappears
 * when the plugin fiber unwinds.
 */
export const SystemPromptPlugin: {
  name: "harness-system-prompt";
  apply(ctx: Context): () => void;
} = {
  name: "harness-system-prompt",
  apply(ctx) {
    let base = "";
    const sections: PromptSection[] = [];

    const service: SystemPromptService = {
      setBase: (prompt) => {
        base = prompt ?? "";
      },
      registerSection: (section) => {
        if (sections.some((s) => s.id === section.id)) {
          throw new Error(`duplicate prompt section registration: ${section.id}`);
        }
        sections.push(section);
      },
      build: (skills) => {
        const ordered = sections
          .map((section, index) => ({ section, index }))
          .sort((a, b) => a.section.order - b.section.order || a.index - b.index);
        let prompt = base;
        for (const { section } of ordered) {
          const rendered = section.render();
          if (rendered) prompt = prompt ? `${prompt}\n\n${rendered}` : rendered;
        }
        return appendSkillIndex(prompt, skills);
      },
    };

    return ctx.provide("systemPrompt", service);
  },
};
