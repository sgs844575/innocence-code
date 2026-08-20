import { describe, expect, it } from "vitest";
import { sha256Hex } from "@innocencecode/harness-core";
import type { AttributionPendingEvent, TaskEvent } from "../src";
import { fakeTaskRuntime, runParentTaskWithChild } from "./helpers";

describe("delegated child changes", () => {
  it("does not count delegated child changes twice", async () => {
    const task = fakeTaskRuntime();
    await runParentTaskWithChild({ task });
    expect(task.changeEvents.filter((event) => event.path === "src/a.ts")).toHaveLength(1);
  });

  it("records the child change exactly once with source delegated under the parent task", async () => {
    const task = fakeTaskRuntime();
    await runParentTaskWithChild({ task });

    expect(task.changeEvents).toEqual([
      {
        type: "changeRecorded",
        path: "src/a.ts",
        source: "delegated",
        beforeHash: null,
        afterHash: sha256Hex("child content"),
      },
    ]);
    // Exactly one acquisition — the child Write. The parent's delegated tool
    // call never captured, which is what keeps the count single.
    expect(task.calls.filter((call) => call === "acquireMutationContext")).toHaveLength(1);
    expect(task.openContexts).toBe(0);
    // A declared write (even delegated) never pauses for attribution.
    expect(task.status).toBe("running");
  });

  it("routes unknown changes observed in the child window to the parent task exactly once", async () => {
    // The child's Write window also observes an unknown change: it must reach
    // the parent task once (through the child's inherited scope), not twice.
    const task = fakeTaskRuntime({
      observedChanges: [{ path: "src/unrelated.ts", source: "unknown", beforeHash: null, afterHash: "h" }],
    });
    await runParentTaskWithChild({ task });

    const pendingEvents = task.events.filter(
      (event: TaskEvent): event is AttributionPendingEvent => event.type === "attributionPending",
    );
    expect(pendingEvents).toEqual([{ type: "attributionPending", paths: ["src/unrelated.ts"] }]);
    expect(task.status).toBe("paused");
    expect(task.changeEvents).toHaveLength(1); // the delegated write, still counted once
  });
});
