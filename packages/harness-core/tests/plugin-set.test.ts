import { describe, expect, it } from "vitest";
import {
  type PluginDescriptor,
  resolvePluginSet,
} from "../src/plugin-set";

/** Mirrors the composePlugins DESCRIPTORS shape (spec B 3.4): fs/shell core. */
const DESCRIPTORS: PluginDescriptor[] = [
  { id: "fs", dependencies: [], core: true },
  { id: "shell", dependencies: [], core: true },
  { id: "subagent", dependencies: ["fs", "shell"] },
  { id: "skills", dependencies: ["fs"] },
  { id: "mcp", dependencies: [] },
  { id: "todo", dependencies: [] },
];

describe("resolvePluginSet", () => {
  it("defaults to everything active", () => {
    expect(resolvePluginSet(DESCRIPTORS).active).toEqual([
      "fs",
      "shell",
      "subagent",
      "skills",
      "mcp",
      "todo",
    ]);
  });

  it("project overrides user: explicit project true re-enables", () => {
    const r = resolvePluginSet(DESCRIPTORS, { subagent: false }, { subagent: true });
    expect(r.active).toContain("subagent");
    expect(r.skipped).toEqual([]);
  });

  it("user-only disable records via user", () => {
    const r = resolvePluginSet(DESCRIPTORS, { subagent: false });
    expect(r.active).not.toContain("subagent");
    expect(r.skipped).toContainEqual({
      id: "subagent",
      reason: "disabled-by-config",
      via: "user",
    });
  });

  it("project false overrides user true and records via project", () => {
    const r = resolvePluginSet(DESCRIPTORS, { subagent: true }, { subagent: false });
    expect(r.active).not.toContain("subagent");
    expect(r.skipped).toContainEqual({
      id: "subagent",
      reason: "disabled-by-config",
      via: "project",
    });
  });

  it("defaults with no toggles keep everything active with no skips", () => {
    const r = resolvePluginSet(DESCRIPTORS);
    expect(r.active).toEqual(["fs", "shell", "subagent", "skills", "mcp", "todo"]);
    expect(r.skipped).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("disabling a dependency skips dependents", () => {
    const r = resolvePluginSet(
      [...DESCRIPTORS, { id: "future", dependencies: ["mcp"] }],
      undefined,
      { mcp: false },
    );
    expect(r.skipped).toContainEqual({
      id: "future",
      reason: "dependency-disabled",
      via: "project",
    });
  });

  it("core cannot be disabled and warns", () => {
    const r = resolvePluginSet(DESCRIPTORS, { fs: false } as never);
    expect(r.active).toContain("fs");
    expect(r.warnings.join()).toContain("fs");
  });

  it("warns on cycles without crashing", () => {
    const r = resolvePluginSet([
      { id: "a", dependencies: ["b"] },
      { id: "b", dependencies: ["a"] },
    ]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("records disabled-by-config with the disabling layer", () => {
    const r = resolvePluginSet(DESCRIPTORS, undefined, { mcp: false });
    expect(r.active).not.toContain("mcp");
    expect(r.skipped).toContainEqual({
      id: "mcp",
      reason: "disabled-by-config",
      via: "project",
    });
  });

  it("most specific disabling layer wins when both layers disable", () => {
    const r = resolvePluginSet(DESCRIPTORS, { skills: false }, { skills: false });
    expect(r.skipped).toContainEqual({
      id: "skills",
      reason: "disabled-by-config",
      via: "project",
    });
  });

  it("disabling a shared dependency skips the whole dependent chain", () => {
    const chain: PluginDescriptor[] = [
      { id: "base", dependencies: [] },
      { id: "mid", dependencies: ["base"] },
      { id: "leaf", dependencies: ["mid"] },
    ];
    const r = resolvePluginSet(chain, undefined, { base: false } as never);
    expect(r.active).toEqual([]);
    expect(r.skipped).toEqual([
      { id: "base", reason: "disabled-by-config", via: "project" },
      { id: "mid", reason: "dependency-disabled", via: "project" },
      { id: "leaf", reason: "dependency-disabled", via: "project" },
    ]);
  });

  it("keeps the resolved plugin active when a dependency is merely untoggled", () => {
    const r = resolvePluginSet(DESCRIPTORS, { todo: true }, { skills: true });
    expect(r.active).toContain("todo");
    expect(r.active).toContain("skills");
    expect(r.skipped).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("warns on unknown toggle keys and ignores them", () => {
    const r = resolvePluginSet(DESCRIPTORS, { bananas: false } as never);
    expect(r.active).toContain("mcp");
    expect(r.warnings.join()).toContain("bananas");
  });

  it("conservatively activates cycle members", () => {
    const r = resolvePluginSet([
      { id: "a", dependencies: ["b"] },
      { id: "b", dependencies: ["a"] },
    ]);
    expect(r.active).toEqual(["a", "b"]);
    expect(r.skipped).toEqual([]);
    expect(r.warnings.join()).toContain("cycle");
  });

  it("skips a dependent whose only disabled dependency came from the user layer", () => {
    const r = resolvePluginSet(
      [...DESCRIPTORS, { id: "future", dependencies: ["mcp"] }],
      { mcp: false },
    );
    expect(r.skipped).toContainEqual({
      id: "future",
      reason: "dependency-disabled",
      via: "user",
    });
  });
});