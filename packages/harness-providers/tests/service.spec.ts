import { Context } from "@innocencecode/kernel";
import {
  ProvidersPlugin,
  createProviderPlugin,
  type Provider,
  type ProvidersService,
} from "@innocencecode/harness-providers";
import { describe, expect, expectTypeOf, it } from "vitest";

// Mirrors harness-tools' test setup: load the plugin into a fresh kernel
// context; `ctx.providers` is live while the plugin fiber is active.
async function withProviders(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(ProvidersPlugin);
  return ctx;
}

describe("provider registration", () => {
  it("exposes exactly what was registered through the gate", async () => {
    const ctx = await withProviders();
    ctx.providers.register({ id: "prov", async *chat() {} });
    expect(ctx.providers.get("prov")?.id).toBe("prov");
  });

  it("rejects duplicate provider ids", async () => {
    const ctx = await withProviders();
    ctx.providers.register({ id: "Twin", async *chat() {} });
    expect(() => ctx.providers.register({ id: "Twin", async *chat() {} })).toThrow(
      "duplicate provider registration: Twin",
    );
    expect(ctx.providers.get("Twin")?.id).toBe("Twin");
  });

  it("lists ids in registration order", async () => {
    const ctx = await withProviders();
    ctx.providers.register({ id: "openai", async *chat() {} });
    ctx.providers.register({ id: "anthropic", async *chat() {} });
    expect(ctx.providers.ids()).toEqual(["openai", "anthropic"]);
  });

  it("get returns undefined for unknown ids", async () => {
    const ctx = await withProviders();
    expect(ctx.providers.get("nope")).toBeUndefined();
  });

  it("lookups expose the readonly-shaped registry results (type-level gate)", async () => {
    const ctx = await withProviders();
    expectTypeOf(ctx.providers.get).returns.toEqualTypeOf<Provider | undefined>();
    expectTypeOf(ctx.providers.ids()).toEqualTypeOf<string[]>();
  });
});

describe("providers service lifecycle on the kernel", () => {
  it("carries the spine plugin name \"harness-providers\"", () => {
    expect(ProvidersPlugin.name).toBe("harness-providers");
  });

  it("publishes the service under \"providers\" while its fiber is active", async () => {
    const ctx = await withProviders();
    expect((ctx as { providers?: ProvidersService }).providers).toBeDefined();
    ctx.providers.register({ id: "prov", async *chat() {} });
    expect(ctx.providers.get("prov")?.id).toBe("prov");
  });

  it("withdraws the service when the plugin fiber is disposed", async () => {
    const ctx = new Context();
    const fiber = await ctx.plugin(ProvidersPlugin);
    const service = ctx.providers;
    ctx.providers.register({ id: "prov", async *chat() {} });
    await fiber.dispose();
    // The withdraw handle returned by `apply` removed the context property;
    // the detached service object stays inert but usable.
    expect((ctx as { providers?: ProvidersService }).providers).toBeUndefined();
    expect(() => service.register({ id: "late", async *chat() {} })).not.toThrow();
  });
});

describe("createProviderPlugin (instance wrapper)", () => {
  it("registers the wrapped instance under its id through the spine service", async () => {
    const ctx = await withProviders();
    const provider: Provider = { id: "from-settings", async *chat() {} };
    const plugin = createProviderPlugin(provider);
    expect(plugin.name).toBe("provider");
    await ctx.plugin(plugin);
    expect(ctx.providers.get("from-settings")).toBe(provider);
    expect(ctx.providers.ids()).toEqual(["from-settings"]);
  });

  it("goes through the registration gate (duplicate ids still reject)", async () => {
    const ctx = await withProviders();
    await ctx.plugin(createProviderPlugin({ id: "dup", async *chat() {} }));
    await expect(
      ctx.plugin(createProviderPlugin({ id: "dup", async *chat() {} })),
    ).rejects.toThrow("duplicate provider registration: dup");
  });
});
