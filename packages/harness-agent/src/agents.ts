import type { Context } from "@innocencecode/kernel";

// Services are typed on `Context` through declaration merging by their
// publisher (kernel ServiceTable contract). The member is live only while the
// agents plugin fiber publishing it is active; before load and after its
// unwind the property is absent at runtime.
declare module "@innocencecode/kernel" {
  interface Context {
    agents: AgentsService;
  }
}

/** One selectable agent definition (id/title/description). */
export interface AgentDef {
  id: string;
  title: string;
  description?: string;
}

/**
 * Agents registry service. Built-in definitions (default/plan/full) are
 * contributed by the host wiring; this service only owns registration and
 * lookup, so any host can register its own set.
 */
export interface AgentsService {
  /** Registers one agent definition; duplicate ids are rejected. */
  register(agent: AgentDef): void;
  byId(id: string): AgentDef | undefined;
  /** Registered agents in registration order (read-only view). */
  all(): readonly AgentDef[];
}

/**
 * Agents spine service plugin. `apply` publishes an {@link AgentsService}
 * under "agents" on the scope owning the plugin context and returns the
 * withdraw handle, so the service disappears when the plugin fiber unwinds.
 */
export const AgentsPlugin: {
  name: "harness-agent";
  apply(ctx: Context): () => void;
} = {
  name: "harness-agent",
  apply(ctx) {
    const registered: AgentDef[] = [];

    const service: AgentsService = {
      register: (agent) => {
        if (registered.some((a) => a.id === agent.id)) {
          throw new Error(`duplicate agent registration: ${agent.id}`);
        }
        registered.push(agent);
      },
      byId: (id) => registered.find((a) => a.id === id),
      all: () => registered,
    };

    return ctx.provide("agents", service);
  },
};
