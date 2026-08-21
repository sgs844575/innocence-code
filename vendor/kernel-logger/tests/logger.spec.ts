import { Context } from "@innocencecode/kernel";
import { LoggerPlugin, type LogEntry, type LoggerService } from "@innocencecode/kernel-logger";
import { describe, expect, it } from "vitest";

// The kernel installs services as runtime properties (`defineProperty`) and
// leaves typing to the publisher through declaration merging on `Context`.
// The logger service is required while the plugin fiber is active in these
// tests; the disposal test casts to an optional member explicitly.
declare module "@innocencecode/kernel" {
  interface Context {
    logger: LoggerService;
  }
}

async function withLogger() {
  const ctx = new Context();
  await ctx.plugin(LoggerPlugin);
  return ctx;
}

describe("kernel logger service", () => {
  it("delivers entries to sinks in registration order", async () => {
    const ctx = await withLogger();
    const order: string[] = [];
    ctx.logger.addSink(() => order.push("a"));
    ctx.logger.addSink(() => order.push("b"));
    ctx.logger.log("info", "hello");
    expect(order).toEqual(["a", "b"]);
  });

  it("filters entries below a sink's minLevel", async () => {
    const ctx = await withLogger();
    const seen: LogEntry[] = [];
    ctx.logger.addSink((e) => seen.push(e), { minLevel: "warn" });
    ctx.logger.log("debug", "noise");
    ctx.logger.log("info", "noise");
    ctx.logger.log("warn", "kept");
    ctx.logger.log("error", "kept");
    expect(seen.map((e) => e.level)).toEqual(["warn", "error"]);
  });

  it("unsubscribes via the returned disposer", async () => {
    const ctx = await withLogger();
    let count = 0;
    const off = ctx.logger.addSink(() => { count += 1; });
    ctx.logger.log("info", "one");
    off();
    ctx.logger.log("info", "two");
    expect(count).toBe(1);
  });

  it("drops all sinks when the plugin fiber is disposed", async () => {
    const ctx = new Context();
    const fiber = await ctx.plugin(LoggerPlugin);
    let count = 0;
    ctx.logger.addSink(() => { count += 1; });
    await fiber.dispose();
    // The service is withdrawn with the fiber, so later `log` calls through
    // the context property are gone; sinks registered on it are cleaned too.
    expect(() => (ctx as { logger?: LoggerService }).logger?.log("info", "x")).not.toThrow();
    expect(count).toBe(0);
  });

  it("log without sinks is silent", async () => {
    const ctx = await withLogger();
    expect(() => ctx.logger.log("error", "nobody listens")).not.toThrow();
  });
});
