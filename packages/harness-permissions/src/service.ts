import type { Context } from "@innocencecode/kernel";
import { PermissionEngine } from "./permission";
import type { PermissionEngineOptions } from "./permission";
import type { PolicyRule } from "./policy";

// Services are typed on `Context` through declaration merging by their
// publisher (kernel ServiceTable contract). The member is live only while
// the permissions plugin fiber publishing it is active; before load and
// after its unwind the property is absent at runtime.
declare module "@innocencecode/kernel" {
  interface Context {
    permissions: PermissionsService;
  }
}

/**
 * Permissions spine service. Holds the session's {@link PermissionEngine}
 * (built with the original engine constructor options, or a shared engine
 * injected by a parent session) so consumers keep the exact engine face
 * AgentSession exposes today — `resolve`, `addRules`, `grantSession`,
 * `setMode`, audit and validateResource are all reachable unchanged
 * through `service.engine`.
 */
export interface PermissionsService {
  /** The engine this service owns or wraps; consume it directly. */
  readonly engine: PermissionEngine;
  /**
   * Registers one policy rule. Registration order is preserved (push
   * semantics, registry registerPolicyRule) and the rule is applied to the
   * engine immediately, so activation-time registrations are all effective
   * before the first resolve — the end state of AgentSession's post-load
   * addRules flush, without the flush step.
   */
  registerPolicyRule(rule: PolicyRule): void;
  /** Registered rules in registration order (read-only view). */
  policyRules(): readonly PolicyRule[];
}

/**
 * Builds a {@link PermissionsService}:
 *  - with {@link PermissionEngineOptions}: constructs a fresh engine with
 *    the original PermissionEngine constructor signature (the session-built
 *    AgentSession path: mode/decider/workspaceRoot/validateResource/audit);
 *  - with a PermissionEngine instance: wraps the injected engine as-is, so
 *    a child session shares the parent's rules and session grants.
 */
export function createPermissionsService(options: PermissionEngineOptions): PermissionsService;
export function createPermissionsService(engine: PermissionEngine): PermissionsService;
export function createPermissionsService(
  arg: PermissionEngineOptions | PermissionEngine,
): PermissionsService {
  const engine = arg instanceof PermissionEngine ? arg : new PermissionEngine(arg);
  const registered: PolicyRule[] = [];
  return {
    engine,
    registerPolicyRule(rule) {
      registered.push(rule);
      engine.addRules([rule]);
    },
    policyRules: () => registered,
  };
}

/** Shape of the permissions spine plugin (kernel Plugin contract). */
export interface PermissionsPlugin {
  readonly name: "harness-permissions";
  apply(ctx: Context): () => void;
}

/**
 * Creates the permissions spine plugin for one {@link PermissionsService}
 * (the engine is session state, so the plugin is created per session).
 * `apply` publishes the service under "permissions" on the scope owning the
 * plugin context and returns the withdraw handle, so the service disappears
 * when the plugin fiber unwinds.
 */
export function createPermissionsPlugin(service: PermissionsService): PermissionsPlugin {
  return {
    name: "harness-permissions",
    apply(ctx) {
      return ctx.provide("permissions", service);
    },
  };
}
