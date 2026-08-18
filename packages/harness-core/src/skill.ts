/**
 * A skill is a prompt package: its description lives in the system-prompt
 * index; the body is loaded on demand and never resident in context.
 */
export interface Skill {
  name: string;
  description: string;
  loadBody(): Promise<string>;
}
