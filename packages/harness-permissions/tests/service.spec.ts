import { Context } from "@innocencecode/kernel";
import {
  createPermissionsPlugin,
  createPermissionsService,
  type PermissionAuditEntry,
  type PermissionsService,
  type PolicyRule,
} from "@innocencecode/harness-permissions";
import { describe, expect, expectTypeOf, it } from "vitest";

// Mirrors harness-tools' test setup: load the plugin into a fresh kernel
// context; `ctx.permissions` is live while the plugin fiber is active.
async function withPermissions(service: PermissionsService): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(createPermissionsPlugin(service));
  return ctx;
}

const denyDecider = { ask: async () => "deny" as const };
const allowEdit: PolicyRule = {
  name: "allow:Edit",
  match: (c) => (c.toolName === "Edit" ? "allow" : "skip"),
};
const denyRead: PolicyRule = {
  name: "deny:Read",
  match: (c) => (c.toolName === "Read" ? "deny" : "skip"),
};

describe("permissions service engine holding", () => {
  it("constructs the engine from the original PermissionEngineOptions (mode/decider/audit)", async () => {
    const entries: PermissionAuditEntry[] = [];
    const service = createPermissionsService({
      mode: "ask",
      decider: denyDecider,
      audit: (entry) => entries.push(entry),
    });
    const r = await service.engine.resolve(
      { toolName: "Edit", resource: { action: "write", kind: "path", scope: "src/a.ts" }, args: {} },
      { readOnly: false, sideEffect: "paths" },
    );
    expect(r).toEqual({ decision: "deny", via: "ask", reason: "用户拒绝" });
    expect(entries).toHaveLength(1);
    expect(entries[0].request.resource.scope).toBe("src/a.ts");
  });

  it("runs the injected hard resource validator (fail-closed, every mode)", async () => {
    const service = createPermissionsService({
      mode: "full",
      decider: denyDecider,
      validateResource: () => {
        throw new Error("blocked resource");
      },
    });
    await expect(
      service.engine.resolve(
        { toolName: "BrowserNavigate", resource: { action: "navigate", kind: "url", scope: "file:///secret" }, args: {} },
        { readOnly: false, sideEffect: "unknown" },
      ),
    ).rejects.toThrow("blocked resource");
  });

  it("wraps an injected engine as-is (shared rules+grants path)", () => {
    const parent = createPermissionsService({ mode: "auto", decider: denyDecider });
    const child = createPermissionsService(parent.engine);
    expect(child.engine).toBe(parent.engine);
  });
});

describe("policy rule registration", () => {
  it("registers rules in push order and applies them to the engine", async () => {
    const service = createPermissionsService({ mode: "ask", decider: denyDecider });
    service.registerPolicyRule(denyRead);
    service.registerPolicyRule(allowEdit);
    expect(service.policyRules().map((r) => r.name)).toEqual(["deny:Read", "allow:Edit"]);

    // Effective immediately: both rules resolve without consulting the decider.
    const r = await service.engine.resolve(
      { toolName: "Read", resource: { action: "read", kind: "path", scope: "src/a.ts" }, args: {} },
      { readOnly: true, sideEffect: "none" },
    );
    expect(r).toEqual({ decision: "deny", via: "denyRule", reason: "deny:Read 命中拒绝规则" });
    const w = await service.engine.resolve(
      { toolName: "Edit", resource: { action: "write", kind: "path", scope: "src/a.ts" }, args: {} },
      { readOnly: false, sideEffect: "paths" },
    );
    expect(w).toEqual({ decision: "allow", via: "allowRule", reason: "allow:Edit 命中允许规则" });
  });

  it("policyRules exposes a readonly view (type-level gate)", () => {
    const service = createPermissionsService({ mode: "ask", decider: denyDecider });
    expectTypeOf(service.policyRules()).toEqualTypeOf<readonly PolicyRule[]>();
  });
});

describe("permissions service lifecycle on the kernel", () => {
  it("carries the spine plugin name \"harness-permissions\"", () => {
    const plugin = createPermissionsPlugin(
      createPermissionsService({ mode: "ask", decider: denyDecider }),
    );
    expect(plugin.name).toBe("harness-permissions");
  });

  it("publishes the service under \"permissions\" while its fiber is active", async () => {
    const service = createPermissionsService({ mode: "ask", decider: denyDecider });
    const ctx = await withPermissions(service);
    expect((ctx as { permissions?: PermissionsService }).permissions).toBe(service);
    ctx.permissions.registerPolicyRule(allowEdit);
    expect(ctx.permissions.policyRules().map((r) => r.name)).toEqual(["allow:Edit"]);
  });

  it("withdraws the service when the plugin fiber is disposed", async () => {
    const ctx = new Context();
    const service = createPermissionsService({ mode: "ask", decider: denyDecider });
    const fiber = await ctx.plugin(createPermissionsPlugin(service));
    expect((ctx as { permissions?: PermissionsService }).permissions).toBeDefined();
    await fiber.dispose();
    // The withdraw handle returned by `apply` removed the context property;
    // the detached service object stays usable.
    expect((ctx as { permissions?: PermissionsService }).permissions).toBeUndefined();
    expect(() => service.registerPolicyRule(allowEdit)).not.toThrow();
  });
});
