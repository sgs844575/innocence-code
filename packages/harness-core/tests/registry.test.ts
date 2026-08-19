import { describe, expect, it } from "vitest";
import { PluginRegistry, type HarnessPlugin } from "../src";

describe("PluginRegistry lifecycle", () => {
  it("disposes activated plugins once in reverse order", async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry();
    await registry.load([
      { name: "a", activate() { calls.push("activate-a"); }, async dispose() { calls.push("dispose-a"); } },
      { name: "b", activate() { calls.push("activate-b"); }, async dispose() { calls.push("dispose-b"); } },
    ]);

    await registry.dispose();
    await registry.dispose();

    expect(calls).toEqual(["activate-a", "activate-b", "dispose-b", "dispose-a"]);
  });

  it("continues disposing after one plugin fails", async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry();
    await registry.load([
      { name: "a", activate() {}, async dispose() { calls.push("a"); } },
      { name: "b", activate() {}, async dispose() { calls.push("b"); throw new Error("b failed"); } },
    ]);

    await expect(registry.dispose()).rejects.toThrow("b failed");
    expect(calls).toEqual(["b", "a"]);
  });

  it("rolls back already activated plugins when activation fails", async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry();
    const plugins: HarnessPlugin[] = [
      { name: "a", activate() {}, async dispose() { calls.push("dispose-a"); } },
      { name: "b", activate() { throw new Error("activate-b failed"); } },
      { name: "c", activate() { calls.push("activate-c"); } },
    ];

    await expect(registry.load(plugins)).rejects.toThrow("activate-b failed");
    await registry.dispose();

    expect(calls).toEqual(["dispose-a"]);
  });
});
