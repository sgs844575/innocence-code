import { Context, KernelError } from "@innocencecode/kernel";
import { Loader } from "@innocencecode/kernel-loader";
import { describe, expect, it } from "vitest";

declare module "@innocencecode/kernel" {
  interface Context {
    /** Probe service published by the scoped-table tests below. */
    probe?: number | string;
  }
}

describe("service publish guards", () => {
  it("rejects publishing under a name owned by the context", () => {
    const ctx = new Context();
    let error: unknown;
    try { ctx.provide("fiber", { rogue: true }); } catch (reason) { error = reason; }
    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).code).toBe("SERVICE_NAME_CONFLICT");
  });

  it("rejects publishing under a method name inherited from the context prototype", () => {
    const ctx = new Context();
    let error: unknown;
    try { ctx.provide("emit", 1); } catch (reason) { error = reason; }
    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).code).toBe("SERVICE_NAME_CONFLICT");
  });

  it("rejects publishing under a method name on a derived scope", () => {
    const ctx = new Context();
    const scope = ctx.derive();
    let error: unknown;
    try { scope.provide("derive", 1); } catch (reason) { error = reason; }
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

// Service access face of this kernel is the context property (`ctx.probe`),
// not a `ctx.services.probe` member; assertions otherwise follow the brief.
describe("scoped service table", () => {
  it("child context shadows parent service without affecting parent", async () => {
    const parent = new Context();
    parent.provide("probe", 1);
    const child = parent.derive();
    expect(child.probe).toBe(1); // resolution walks the prototype chain
    child.provide("probe", 2);
    expect(child.probe).toBe(2); // child own publication shadows the parent
    expect(parent.probe).toBe(1); // parent stays untouched
  });

  it("sibling scopes isolate same-name services", async () => {
    const parent = new Context();
    const a = parent.derive();
    const b = parent.derive();
    a.provide("probe", "a");
    b.provide("probe", "b");
    expect(a.probe).toBe("a");
    expect(b.probe).toBe("b");
    expect(parent.probe).toBeUndefined();
  });

  it("withdraw on child restores parent visibility", async () => {
    const parent = new Context();
    parent.provide("probe", 1);
    const child = parent.derive();
    const off = child.provide("probe", 2);
    off();
    expect(child.probe).toBe(1);
  });

  it("shadowing a parent service is legal on a child context", async () => {
    const parent = new Context();
    parent.provide("probe", 1);
    const child = parent.derive();
    expect(() => child.provide("probe", 2)).not.toThrow(); // shadow is legal
    let error: unknown;
    try { child.provide("probe", 3); } catch (reason) { error = reason; }
    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).code).toBe("DUPLICATE_SERVICE"); // same-scope duplicate still rejected
  });
});
