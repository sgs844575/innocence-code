// M2 (final review fold-in): TaskEventKind in src/shared/taskIpc.ts is a
// hand-mirrored copy of task-core's event vocabulary. These compile-time
// assertions derive the mirror from the source of truth: adding a 15th event
// type to task-core's TaskEvent union (or removing one) fails `npm run
// typecheck` here instead of silently desyncing the renderer push channel.
import { describe, expect, it } from "vitest";
import type { TaskEvent } from "@innocencecode/task-core";
import type { TaskEventKind } from "./taskIpc";

/** Mutual-extends equality: true only when A and B are the same union. */
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;

export type _TaskEventKindMatchesTaskEventType = AssertTrue<Eq<TaskEventKind, TaskEvent["type"]>>;
// The direction that usually rots: every task-core kind is in the mirror...
export type _EveryCoreKindMirrored = AssertTrue<TaskEvent["type"] extends TaskEventKind ? true : false>;
// ...and the mirror contains nothing task-core does not (no dead kinds).
export type _NoDeadMirroredKinds = AssertTrue<TaskEventKind extends TaskEvent["type"] ? true : false>;

describe("TaskEventKind parity (compile-time)", () => {
  it("runs (the assertions are enforced by tsc via the exported types above)", () => {
    expect(true).toBe(true);
  });
});
