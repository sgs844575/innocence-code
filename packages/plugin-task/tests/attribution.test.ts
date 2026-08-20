import { describe, expect, it } from "vitest";
import { sha256Hex } from "@innocencecode/harness-core";
import {
  classifyUnknownChanges,
  excludedPaths,
  hasUnresolvedAttribution,
  resolveAsExternal,
  resolveAsTaskOwned,
  resolveTaskAttribution,
  toAttributionPending,
  unresolvedPaths,
  type ObservedChange,
} from "../src";
import { fakeTaskRuntime, seedPendingAttribution, testTaskScope } from "./helpers";

const observed: ObservedChange = {
  path: "src/a.ts",
  source: "unknown",
  beforeHash: null,
  afterHash: "hash-1",
};

describe("attribution state machine", () => {
  it("moves a candidate change to attribution-pending", () => {
    const decision = toAttributionPending(observed);
    expect(decision.status).toBe("attribution-pending");
    expect(decision.path).toBe("src/a.ts");
    expect(decision.source).toBe("unknown");
    expect(decision.beforeHash).toBeNull();
    expect(decision.afterHash).toBe("hash-1");
    expect(hasUnresolvedAttribution([decision])).toBe(true);
    expect(unresolvedPaths([decision])).toEqual(["src/a.ts"]);
  });

  it("resolves attribution-pending as task-owned into pending review", () => {
    const decision = resolveAsTaskOwned(toAttributionPending(observed));
    expect(decision.status).toBe("pending-review");
    expect(hasUnresolvedAttribution([decision])).toBe(false);
    // Fail closed: only attribution-pending decisions can be resolved.
    expect(() => resolveAsTaskOwned(decision)).toThrow("attribution-pending");
  });

  it("resolves attribution-pending as external into excluded with a protected external version", () => {
    const decision = resolveAsExternal(toAttributionPending(observed));
    expect(decision.status).toBe("excluded");
    expect(decision.protectedHash).toBe("hash-1"); // restore/apply must never touch this content
    expect(hasUnresolvedAttribution([decision])).toBe(false);
    expect(excludedPaths([decision])).toEqual(["src/a.ts"]);
  });

  it("flags candidates overlapping an expected write as conflicts", () => {
    const { conflicts, pending } = classifyUnknownChanges(
      [
        { path: "src/shared.ts", source: "unknown", beforeHash: null, afterHash: "x" },
        { path: "src/other.ts", source: "unknown", beforeHash: null, afterHash: "y" },
      ],
      ["src/shared.ts"],
    );
    expect(conflicts.map((change) => change.path)).toEqual(["src/shared.ts"]);
    expect(pending.map((change) => change.path)).toEqual(["src/other.ts"]);
  });

  it("never mutates the input decision", () => {
    const pending = toAttributionPending(observed);
    const resolved = resolveAsExternal(pending);
    expect(pending.status).toBe("attribution-pending");
    expect(pending.protectedHash).toBeNull();
    expect(resolved.status).toBe("excluded");
  });
});

describe("resolveTaskAttribution (port orchestration)", () => {
  it("resolves external attribution through the port and lifts the pause", async () => {
    const task = fakeTaskRuntime({ files: { "src/a.ts": "external edit" } });
    await seedPendingAttribution(task, ["src/a.ts"]);
    expect(task.status).toBe("paused");

    const resolved = await resolveTaskAttribution(task, testTaskScope("Attribution"), {
      path: "src/a.ts",
      attribution: "external",
    });

    expect(resolved.status).toBe("excluded");
    expect(resolved.protectedHash).toBe(sha256Hex("external edit"));
    expect(task.events).toContainEqual({
      type: "attributionResolved",
      path: "src/a.ts",
      attribution: "external",
      status: "excluded",
      protectedHash: sha256Hex("external edit"),
    });
    expect(task.status).toBe("running");
    expect(excludedPaths(task.decisions)).toEqual(["src/a.ts"]);
    expect(task.openContexts).toBe(0);
  });

  it("resolves task-owned attribution into pending review", async () => {
    const task = fakeTaskRuntime();
    await seedPendingAttribution(task, ["src/a.ts"]);

    const resolved = await resolveTaskAttribution(task, testTaskScope("Attribution"), {
      path: "src/a.ts",
      attribution: "task-owned",
    });

    expect(resolved.status).toBe("pending-review");
    expect(resolved.protectedHash).toBeNull();
    expect(task.status).toBe("review");
    expect(hasUnresolvedAttribution(task.decisions)).toBe(false);
  });

  it("fails closed for an untracked path and still disposes its context", async () => {
    const task = fakeTaskRuntime();
    await expect(
      resolveTaskAttribution(task, testTaskScope("Attribution"), {
        path: "src/none.ts",
        attribution: "external",
      }),
    ).rejects.toThrow("no decision tracked");
    expect(task.openContexts).toBe(0);
  });
});
