import { Context, KernelError } from "@innocencecode/kernel";
import { Loader } from "@innocencecode/kernel-loader";
import { describe, expect, it } from "vitest";

describe("service publish guards", () => {
  it("rejects publishing under a name owned by the context", () => {
    const ctx = new Context();
    let error: unknown;
    try { ctx.provide("fiber", { rogue: true }); } catch (reason) { error = reason; }
    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).code).toBe("SERVICE_NAME_CONFLICT");
  });

  it("rejects a duplicate service name and keeps the published one", async () => {
    const ctx = new Context();
    await ctx.plugin(Loader);
    const original = ctx.services.resolve("loader");
    let error: unknown;
    try { ctx.provide("loader", { rogue: true }); } catch (reason) { error = reason; }
    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).code).toBe("DUPLICATE_SERVICE");
    expect((error as KernelError).message).toMatch(/withdraw/);
    // The guards run before any mutation, so the live service is untouched.
    expect(ctx.services.resolve("loader")).toBe(original);
  });

  it("allows republishing a name after its service is withdrawn", () => {
    const ctx = new Context();
    const first = { tag: "first" };
    const withdraw = ctx.provide("probe", first);
    expect(ctx.services.resolve("probe")).toBe(first);
    withdraw();
    expect(ctx.services.resolve("probe")).toBeUndefined();
    const second = { tag: "second" };
    expect(() => ctx.provide("probe", second)).not.toThrow();
    expect(ctx.services.resolve("probe")).toBe(second);
  });
});
