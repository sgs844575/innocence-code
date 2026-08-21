import type { Context } from "@innocencecode/kernel";
import type { ToolSpec } from "./provider";
import type { Tool } from "./tool";
import type { ToolExecutionMiddleware } from "./tool-execution";

// Services are typed on `Context` through declaration merging by their
// publisher (kernel ServiceTable contract). The member is live only while
// the ToolsPlugin fiber publishing it is active; before load and after its
// unwind the property is absent at runtime.
declare module "@innocencecode/kernel" {
  interface Context {
    tools: ToolsService;
  }
}

/** Error code for the fail-closed tool persistence SPI gate. */
export const TOOL_PERSISTENCY_POLICY_REQUIRED = "tool-persistence-policy-required";

/**
 * Thrown when a Tool lacks persistArgs/permissionResource. There is no
 * legacy fallback: raw-argument persistence is never silently restored.
 */
export class ToolPersistenceError extends Error {
  readonly code = TOOL_PERSISTENCY_POLICY_REQUIRED;

  constructor(toolName: string, member: "permissionResource" | "persistArgs") {
    super(
      `tool ${toolName} must implement ${member} (${TOOL_PERSISTENCY_POLICY_REQUIRED}): ` +
        "every Tool has to declare a persistence-safe permission resource and persisted args copy",
    );
    this.name = "ToolPersistenceError";
  }
}

/** Tools registration surface published by {@link ToolsPlugin} under "tools". */
export interface ToolsService {
  /**
   * Registers a tool through the fail-closed SPI gate: duplicate names are
   * rejected, and a Tool missing `permissionResource` or `persistArgs`
   * throws {@link ToolPersistenceError}.
   */
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  /** Provider-facing descriptions of every registered tool. */
  specs(): ToolSpec[];
  /**
   * Registers execution-time middleware around every tool invocation.
   * Registration order is preserved; later registrations wrap closer to the
   * tool (inner layers), earlier ones run first.
   */
  registerMiddleware(middleware: ToolExecutionMiddleware): void;
  /** Execution middleware in registration order (later = inner layer). */
  middlewares(): readonly ToolExecutionMiddleware[];
}

/**
 * Tools spine service plugin. `apply` publishes a {@link ToolsService} under
 * "tools" on the scope owning the plugin context and returns the withdraw
 * handle, so the service disappears when the plugin fiber unwinds.
 */
export const ToolsPlugin: { name: "harness-tools"; apply(ctx: Context): () => void } = {
  name: "harness-tools",
  apply(ctx) {
    const registeredTools = new Map<string, Tool>();
    /** Execution middleware in registration order (later = inner layer). */
    const registeredMiddlewares: ToolExecutionMiddleware[] = [];

    const service: ToolsService = {
      register: (tool) => {
        if (registeredTools.has(tool.name)) {
          throw new Error(`duplicate tool registration: ${tool.name}`);
        }
        // Fail-closed persistence SPI: raw args must never be persistable by
        // default. Tool error messages must not contain raw args either — they
        // enter history/audit unredacted (see Tool.execute).
        if (typeof tool.permissionResource !== "function") {
          throw new ToolPersistenceError(tool.name, "permissionResource");
        }
        if (typeof tool.persistArgs !== "function") {
          throw new ToolPersistenceError(tool.name, "persistArgs");
        }
        registeredTools.set(tool.name, tool);
      },
      get: (name) => registeredTools.get(name),
      specs: () =>
        [...registeredTools.values()].map((t) => ({
          name: t.name,
          description: t.description,
          readOnly: t.readOnly,
          parameters: t.parameters,
        })),
      registerMiddleware: (middleware) => {
        registeredMiddlewares.push(middleware);
      },
      middlewares: () => registeredMiddlewares,
    };

    return ctx.provide("tools", service);
  },
};
