import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "../src/registry";
import { loadPluginToggles } from "../src/plugin-toggles";

let root: string;

/** Collects logger calls so assertions can inspect emitted warnings. */
function captureLogger(): { logs: Array<{ level: string; msg: string }>; logger: Logger } {
  const logs: Array<{ level: string; msg: string }> = [];
  const logger: Logger = (level, msg) => {
    logs.push({ level, msg });
  };
  return { logs, logger };
}

async function writePluginsYml(content: string): Promise<void> {
  await mkdir(path.join(root, ".innocence"), { recursive: true });
  await writeFile(path.join(root, ".innocence", "plugins.yml"), content, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "plugin-toggles-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadPluginToggles", () => {
  it("reads boolean toggles from .innocence/plugins.yml", async () => {
    await writePluginsYml("plugins:\n  mcp: false\n  skills: true\n");
    const { logs, logger } = captureLogger();
    await expect(loadPluginToggles(root, { logger })).resolves.toEqual({
      mcp: false,
      skills: true,
    });
    expect(logs).toEqual([]);
  });

  it("returns undefined when the file is missing without warning", async () => {
    const { logs, logger } = captureLogger();
    await expect(loadPluginToggles(root, { logger })).resolves.toBeUndefined();
    expect(logs).toEqual([]);
  });

  it("returns undefined with a visible warning on broken yaml", async () => {
    await writePluginsYml("plugins: [broken");
    const { logs, logger } = captureLogger();
    await expect(loadPluginToggles(root, { logger })).resolves.toBeUndefined();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].level).toBe("warn");
  });

  it("returns undefined with a warning when plugins is not a mapping", async () => {
    await writePluginsYml("plugins: [1, 2]\n");
    const { logs, logger } = captureLogger();
    await expect(loadPluginToggles(root, { logger })).resolves.toBeUndefined();
    expect(logs.length).toBeGreaterThan(0);
  });

  it("returns undefined with a warning when the document is not an object", async () => {
    await writePluginsYml("- just\n- a\n- list\n");
    const { logs, logger } = captureLogger();
    await expect(loadPluginToggles(root, { logger })).resolves.toBeUndefined();
    expect(logs.length).toBeGreaterThan(0);
  });

  it("warns and ignores unknown plugin keys", async () => {
    await writePluginsYml("plugins:\n  bananas: false\n  todo: true\n");
    const { logs, logger } = captureLogger();
    await expect(loadPluginToggles(root, { logger })).resolves.toEqual({ todo: true });
    expect(logs.length).toBe(1);
    expect(logs[0].msg).toContain("bananas");
  });

  it("warns and ignores non-boolean values", async () => {
    await writePluginsYml("plugins:\n  mcp: 'nope'\n  todo: false\n");
    const { logs, logger } = captureLogger();
    await expect(loadPluginToggles(root, { logger })).resolves.toEqual({ todo: false });
    expect(logs.length).toBe(1);
    expect(logs[0].msg).toContain("mcp");
  });

  it("returns undefined when the plugins section is absent", async () => {
    await writePluginsYml("something_else: true\n");
    const { logs, logger } = captureLogger();
    await expect(loadPluginToggles(root, { logger })).resolves.toBeUndefined();
    expect(logs).toEqual([]);
  });

  it("falls back to console.warn when no logger is injected", async () => {
    await writePluginsYml("plugins: [broken");
    const original = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      await expect(loadPluginToggles(root)).resolves.toBeUndefined();
    } finally {
      console.warn = original;
    }
    expect(calls.length).toBeGreaterThan(0);
  });
});
