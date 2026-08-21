// Runtime TYPES and shared constants: the hooks, contexts and option
// surfaces of the harness runtime (split from runtime.ts by responsibility —
// see route-cache.ts for the cache mechanics, turn-persistence.ts and
// runtime-events.ts for the remaining collaborators).
import type { PermissionRequest } from "@innocencecode/harness-permissions";
import type { Message, ToolCallPart, ToolResultPart } from "@innocencecode/harness-session";
import type { Provider } from "@innocencecode/harness-providers";
import type { ExecutionScope, Tool } from "@innocencecode/harness-tools";
import type { AgentSession } from "./session";
import type { SessionPlugin } from "./registry";
import type { SessionSpineSuite } from "./session-spine";
import type { Context } from "@innocencecode/kernel";
import type { Route } from "@innocencecode/task-core";
import type { HarnessSettings } from "./settings";

/** Route id plain chat turns run on; the transcript codec maps v2 rows here. */
export const DEFAULT_ROUTE_ID = "main";

export type AskResponse = "allow" | "allowSession" | "deny";

export interface PermissionAsk {
  requestId: string;
  /** The persisted (redacted) permission request — raw args never reach the host. */
  call: PermissionRequest;
}

/** Structured tool event forwarded to the host (call and result arrive
 *  separately; pair them via id / toolCallId). */
export type LiveToolPart = ToolCallPart | (ToolResultPart & { durationMs: number });

/** Hooks the host implements to bridge UI, storage and dialogs. */
export interface RuntimeHooks {
  /** Text delta for the streaming assistant message. */
  onDelta(sessionId: string, messageId: string, delta: string): void;
  /** Structured tool events (call and result arrive separately; pair them via id/toolCallId). */
  onTool(sessionId: string, messageId: string, part: LiveToolPart): void;
  /** Thinking deltas (harness-core does not emit these yet; the channel is ready). */
  onThinking(sessionId: string, messageId: string, delta: string): void;
  onCompleted(sessionId: string, messageId: string): void;
  onError(sessionId: string, messageId: string, error: string): void;
  /** Ask the user about a tool call; resolves with their choice. */
  askPermission(sessionId: string, messageId: string, ask: PermissionAsk): Promise<AskResponse>;
  log(level: "info" | "warn" | "error", msg: string, data?: unknown): void;
}

/**
 * Late-bound view over the session's registered tools. Plugins are composed
 * BEFORE the AgentSession exists, so a host plugin that needs tool metadata
 * at execution time (e.g. the task capture middleware's lookupTool) receives
 * this index in its factory context; the runtime adopts the session's
 * registry right after the build, always before the first tool invocation.
 */
export interface SessionToolIndex {
  get(toolName: string): Tool | undefined;
}

/** Builds a SessionToolIndex that adopts a session's registry after the build. */
export function createSessionToolIndex(): SessionToolIndex & {
  adopt(tools: ReadonlyMap<string, Tool>): void;
} {
  let adopted: ReadonlyMap<string, Tool> | undefined;
  return {
    get: (toolName) => adopted?.get(toolName),
    adopt(tools) {
      adopted = tools;
    },
  };
}

/**
 * Everything the host composition root needs to assemble one session's
 * plugin set. The runtime owns no concrete plugin — hosts (Electron glue,
 * CLI, tests) decide which capabilities each session gets.
 */
export interface PluginFactoryContext {
  /** Host-level chat session id (the route key's session part). */
  sessionId: string;
  /** Route the session serves (normalized; plain chat turns use "main"). */
  routeId: string;
  /** Task identity when the route belongs to a task; undefined for plain chat. */
  taskId?: string;
  /** Id of the message/turn that triggered this session build. */
  messageId: string;
  /** Settings value this session is built under (settings() at build time). */
  settings: HarnessSettings;
  /** Resolved workspace root (never empty; falls back to process.cwd()). */
  workspaceRoot: string;
  /**
   * Correlation scope for the session bootstrap: a fresh invocation id
   * stamped with the chat session + route (and task, when present) identity.
   */
  scope: ExecutionScope;
  /** Late-bound tool index; resolves names after the session's build. */
  toolIndex: SessionToolIndex;
}

/** One agent turn: route/task identity plus the user input and host message id. */
export interface RuntimeSendRequest {
  sessionId: string;
  /** Owning task id; "" for plain (non-task) chat turns. */
  taskId: string;
  routeId: string;
  text: string | Message;
  messageId: string;
}

/** Route identity a host needs to resolve a route-scoped workspace root. */
export interface RouteWorkspaceContext {
  sessionId: string;
  routeId: string;
  /** Task identity when the route belongs to a task; undefined for plain chat. */
  taskId?: string;
  messageId: string;
}

export interface RuntimeForkRouteInput {
  sessionId: string;
  taskId: string;
  sourceRouteId: string;
  sourceTurnId: string;
  mode: "edit-user" | "retry-assistant";
  editedText?: string;
  routeName: string;
}

/**
 * Kernel scope handle one route session mounts into (the kernel's
 * `createScope` product; structurally satisfied by any such handle). The
 * session's publications shadow the host root's names inside the scope, and
 * session disposal unwinds the scope fiber — host and session can tear the
 * route down from either side.
 */
export interface SessionScope {
  readonly ctx: Context;
  dispose(): Promise<void>;
}

export interface RuntimeOptions {
  settings(): HarnessSettings;
  hooks: RuntimeHooks;
  /** Host composition root: supplies the plugin set for each agent session
   *  (legacy HarnessPlugins and kernel-native plugins alike). */
  pluginsForSession(context: PluginFactoryContext): Promise<SessionPlugin[]> | SessionPlugin[];
  /**
   * Route-scoped workspace root (a task's worktree, a session-bound project
   * root...): consulted BEFORE plugin composition and AgentSession.create,
   * so a task route's tools, permission scopes and change captures all act
   * on the task's effective workspace instead of settings.workspaceRoot.
   * An absent hook, undefined or an empty result falls back to the settings
   * root — settings.workspaceRoot is never the sole task root.
   */
  workspaceRootFor?(
    context: RouteWorkspaceContext,
  ): string | undefined | Promise<string | undefined>;
  /** Host port that owns Git/task storage orchestration for route creation. */
  forkRoute?(input: RuntimeForkRouteInput): Promise<Route & { prompt: string }>;
  /** Directory for JSONL session transcripts; omitted = no persistence. */
  persistDir?: string;
  /**
   * Kernel scope factory for route sessions: called once per session BUILD
   * (cache hits reuse the existing session and never call it), and each call
   * must produce a FRESH scope below the host's root — the session mounts
   * into it (AgentSessionOptions.scope) and unwinds it on dispose. Omitted =
   * every session keeps its own self-contained kernel root (pre-existing
   * behavior, and what every test that predates route scopes exercises).
   */
  sessionScope?: () => SessionScope | Promise<SessionScope>;
  /**
   * Spine suite factory for route sessions: called once per session BUILD
   * (cache hits reuse the existing session and never call it); the returned
   * suite is injected into AgentSession.create so the session mounts the
   * SAME spine module identities the host loaded from its distribution tree
   * (boot root, session scopes and disk-loaded capability plugins stay
   * single-sourced). Omitted = every session mounts the bundled static spine
   * (pre-distribution behavior, and what every spine-agnostic test uses).
   */
  sessionSpine?: () => SessionSpineSuite | Promise<SessionSpineSuite>;
  /**
   * Replaces the composition-layer provider plugin (test seam): the returned
   * instance is wrapped as a provider plugin and enters the providers
   * registry like every other session provider.
   */
  providerFactory?: (settings: HarnessSettings) => Provider;
  /**
   * Wraps the AgentSession construction (test seam): receives the factory
   * context plus the deferred default build, and must produce the session
   * that enters the route cache.
   */
  agentFactory?: (
    context: PluginFactoryContext,
    create: () => Promise<AgentSession>,
  ) => Promise<AgentSession>;
}
