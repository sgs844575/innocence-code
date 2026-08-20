import { describe, expect, it } from "vitest";
import { sha256Hex, type Tool, type ToolExecutionInvocation } from "@innocencecode/harness-core";
import {
  ATTRIBUTION_BLOCKED,
  attributionBlockedResult,
  createTaskCaptureMiddleware,
  isAttributionBlocked,
  taskPlugin,
} from "../src";
import {
  TEST_WORKSPACE_ROOT,
  createSessionWith,
  fakeReadTool,
  fakeShellTool,
  fakeTaskRuntime,
  fakeWriteTool,
  scriptedProvider,
  seedPendingAttribution,
  testTaskScope,
  toolLookup,
} from "./helpers";

describe("task change-capture middleware", () => {
  it("captures a declared write before and after, appends changeRecorded and disposes the context", async () => {
    const task = fakeTaskRuntime();
    const tools = [fakeWriteTool(task)];
    const plugin = taskPlugin({
      port: task,
      lookupTool: toolLookup(tools),
      workspaceRoot: TEST_WORKSPACE_ROOT,
    });
    const session = await createSessionWith(
      plugin,
      tools,
      scriptedProvider([
        [{ type: "toolCall", id: "t1", toolName: "Write", args: { path: "src/a.ts", content: "after-content" } }],
        [{ type: "text", text: "done" }],
      ]),
    );

    const summary = await session.run("write it", undefined, { taskId: "task-1" });

    expect(summary.finalText).toBe("done");
    expect(task.changeEvents).toEqual([
      {
        type: "changeRecorded",
        path: "src/a.ts",
        source: "declared",
        beforeHash: null,
        afterHash: sha256Hex("after-content"),
      },
    ]);
    // Fixed middleware flow: permission passed → acquire → expected version →
    // attribution gate → before → tool → after → event → dispose.
    expect(task.calls).toEqual([
      "acquireMutationContext",
      "readExpectedVersion",
      "requireAttribution",
      "captureBefore",
      "captureAfter",
      "append",
      "dispose",
    ]);
    expect(task.openContexts).toBe(0);
    expect(task.status).toBe("running");
  });

  it("pauses unknown changes for explicit attribution", async () => {
    const task = fakeTaskRuntime({
      observedChanges: [{ path: "src/a.ts", source: "unknown", beforeHash: null, afterHash: "hash-1" }],
    });
    const tools = [fakeShellTool()];
    const plugin = taskPlugin({
      port: task,
      lookupTool: toolLookup(tools),
      workspaceRoot: TEST_WORKSPACE_ROOT,
    });
    const session = await createSessionWith(
      plugin,
      tools,
      scriptedProvider([
        [{ type: "toolCall", id: "t1", toolName: "Shell", args: { command: "echo hi" } }],
        [{ type: "text", text: "done" }],
      ]),
    );

    await session.run("run command", undefined, { taskId: "task-1" });

    expect(task.events).toContainEqual({ type: "attributionPending", paths: ["src/a.ts"] });
    expect(task.status).toBe("paused");
  });

  it("blocks write tools while attribution is pending", async () => {
    const task = fakeTaskRuntime({
      observedChanges: [{ path: "src/a.ts", source: "unknown", beforeHash: null, afterHash: "hash-1" }],
    });
    let writeExecuted = 0;
    const writeTool = fakeWriteTool(task, { onExecute: () => { writeExecuted += 1; } });
    const tools = [fakeShellTool(), writeTool];
    const plugin = taskPlugin({
      port: task,
      lookupTool: toolLookup(tools),
      workspaceRoot: TEST_WORKSPACE_ROOT,
    });
    const session = await createSessionWith(
      plugin,
      tools,
      scriptedProvider([
        [{ type: "toolCall", id: "t1", toolName: "Shell", args: { command: "echo hi" } }],
        [{ type: "text", text: "first done" }],
        [{ type: "toolCall", id: "t2", toolName: "Write", args: { path: "src/b.ts", content: "nope" } }],
        [{ type: "text", text: "second done" }],
      ]),
    );

    await session.run("run command", undefined, { taskId: "task-1" });
    await session.run("now write", undefined, { taskId: "task-1" });

    expect(task.status).toBe("paused");
    expect(writeExecuted).toBe(0);
    const blockedResult = session.history
      .flatMap((message) => message.parts)
      .find((part) => part.type === "toolResult" && part.content.includes("未归属"));
    expect(blockedResult).toMatchObject({ type: "toolResult", isError: true });
    // The blocked invocation acquired a context but never captured or appended.
    expect(task.calls).toEqual([
      "acquireMutationContext",
      "readExpectedVersion",
      "requireAttribution",
      "captureBefore",
      "captureAfter",
      "append",
      "dispose",
      "acquireMutationContext",
      "readExpectedVersion",
      "requireAttribution",
      "dispose",
    ]);
    expect(task.openContexts).toBe(0);
    expect(task.changeEvents).toHaveLength(0);
  });

  it("returns a typed refusal without running the tool when attribution is pending", async () => {
    const task = fakeTaskRuntime();
    const writeTool = fakeWriteTool(task);
    const middleware = createTaskCaptureMiddleware({
      port: task,
      lookupTool: toolLookup([writeTool]),
      workspaceRoot: TEST_WORKSPACE_ROOT,
    });
    await seedPendingAttribution(task, ["src/a.ts"]);

    const scope = testTaskScope("Write");
    const invocation: ToolExecutionInvocation = {
      invocationId: scope.invocationId,
      toolName: "Write",
      persistedArgs: { path: "src/b.ts" },
      signal: new AbortController().signal,
      scope,
    };
    const result = await middleware.execute(invocation, () =>
      Promise.reject(new Error("tool must not run while attribution is pending")),
    );

    expect(isAttributionBlocked(result)).toBe(true);
    expect(result.isError).toBe(true);
    expect(task.changeEvents).toHaveLength(0);
  });

  it("builds a typed attribution refusal result", () => {
    const refusal = attributionBlockedResult(["src/a.ts"]);
    expect(refusal.isError).toBe(true);
    expect(refusal.blocked).toBe(ATTRIBUTION_BLOCKED);
    expect(refusal.paths).toEqual(["src/a.ts"]);
    expect(refusal.content).toContain("src/a.ts");
    expect(isAttributionBlocked({ content: "unrelated" })).toBe(false);
  });

  it("does not capture when the invocation runs without a task scope", async () => {
    const task = fakeTaskRuntime();
    let writeExecuted = 0;
    const tools = [fakeWriteTool(task, { onExecute: () => { writeExecuted += 1; } })];
    const plugin = taskPlugin({
      port: task,
      lookupTool: toolLookup(tools),
      workspaceRoot: TEST_WORKSPACE_ROOT,
    });
    const session = await createSessionWith(
      plugin,
      tools,
      scriptedProvider([
        [{ type: "toolCall", id: "t1", toolName: "Write", args: { path: "src/a.ts", content: "x" } }],
        [{ type: "text", text: "done" }],
      ]),
    );

    await session.run("write it"); // no taskId/routeId identity on the run

    expect(writeExecuted).toBe(1);
    expect(task.calls).toHaveLength(0);
    expect(task.changeEvents).toHaveLength(0);
  });

  it("skips capture for read-only tools", async () => {
    const task = fakeTaskRuntime();
    let readExecuted = 0;
    const tools = [fakeReadTool({ onExecute: () => { readExecuted += 1; } })];
    const plugin = taskPlugin({
      port: task,
      lookupTool: toolLookup(tools),
      workspaceRoot: TEST_WORKSPACE_ROOT,
    });
    const session = await createSessionWith(
      plugin,
      tools,
      scriptedProvider([
        [{ type: "toolCall", id: "t1", toolName: "Read", args: {} }],
        [{ type: "text", text: "done" }],
      ]),
    );

    await session.run("read it", undefined, { taskId: "task-1" });

    expect(readExecuted).toBe(1);
    expect(task.calls).toHaveLength(0);
  });

  it("captures after and disposes the context even when the tool throws", async () => {
    const task = fakeTaskRuntime();
    const tools = [fakeWriteTool(task, { failWith: new Error("disk full") })];
    const plugin = taskPlugin({
      port: task,
      lookupTool: toolLookup(tools),
      workspaceRoot: TEST_WORKSPACE_ROOT,
    });
    const session = await createSessionWith(
      plugin,
      tools,
      scriptedProvider([
        [{ type: "toolCall", id: "t1", toolName: "Write", args: { path: "src/a.ts", content: "x" } }],
        [{ type: "text", text: "done" }],
      ]),
    );

    await session.run("write it", undefined, { taskId: "task-1" });

    const toolResult = session.history
      .flatMap((message) => message.parts)
      .find((part) => part.type === "toolResult");
    expect(toolResult).toMatchObject({ isError: true });
    expect(task.calls).toEqual([
      "acquireMutationContext",
      "readExpectedVersion",
      "requireAttribution",
      "captureBefore",
      "captureAfter",
      "dispose",
    ]);
    // The tool never wrote, so before/after hashes match: nothing recorded.
    expect(task.changeEvents).toHaveLength(0);
    expect(task.openContexts).toBe(0);
  });

  it("marks unknown changes overlapping the declared write as conflicts", async () => {
    const task = fakeTaskRuntime({
      observedChanges: [
        { path: "src/a.ts", source: "unknown", beforeHash: null, afterHash: sha256Hex("someone-else") },
      ],
    });
    const tools = [fakeWriteTool(task)];
    const plugin = taskPlugin({
      port: task,
      lookupTool: toolLookup(tools),
      workspaceRoot: TEST_WORKSPACE_ROOT,
    });
    const session = await createSessionWith(
      plugin,
      tools,
      scriptedProvider([
        [{ type: "toolCall", id: "t1", toolName: "Write", args: { path: "src/a.ts", content: "own content" } }],
        [{ type: "text", text: "done" }],
      ]),
    );

    await session.run("write it", undefined, { taskId: "task-1" });

    expect(task.changeEvents).toHaveLength(1); // the task's own write is still recorded once
    expect(task.events).toContainEqual({ type: "attributionConflict", paths: ["src/a.ts"] });
    expect(task.events).not.toContainEqual({ type: "attributionPending", paths: ["src/a.ts"] });
    expect(task.status).toBe("paused");
    expect(task.decisions.some((decision) => decision.path === "src/a.ts" && decision.status === "conflict")).toBe(
      true,
    );
  });

  it("rejects port mutations attempted without an active mutation context", async () => {
    const task = fakeTaskRuntime();
    const context = await task.acquireMutationContext(testTaskScope());
    await context[Symbol.asyncDispose]();

    await expect(
      task.append(context, { type: "attributionPending", paths: ["src/a.ts"] }),
    ).rejects.toThrow("active TaskMutationContext");

    // No contextless mutation overload exists — the call is a type error AND a
    // runtime failure (the fake, like the real runtime, demands a lease).
    await expect(
      // @ts-expect-error append requires a TaskMutationContext; there is no contextless overload
      task.append({ type: "attributionPending", paths: ["src/a.ts"] }),
    ).rejects.toThrow();
  });

  // sideEffect is OPTIONAL on the P0 Tool interface; readOnly is the
  // authoritative write signal. A readOnly:false tool that omits the field
  // must fail CLOSED (default "unknown", like the permission engine) — it
  // goes through capture AND the attribution write-block.
  describe("tools omitting the optional sideEffect field", () => {
    const undeclaredWriteTool = (runtime: ReturnType<typeof fakeTaskRuntime>, options?: Parameters<typeof fakeWriteTool>[1]): Tool => ({
      ...fakeWriteTool(runtime, options),
      description: "write tool omitting the optional sideEffect field",
      sideEffect: undefined,
    });

    it("is captured like any other write tool", async () => {
      const task = fakeTaskRuntime();
      const tools = [undeclaredWriteTool(task)];
      const plugin = taskPlugin({
        port: task,
        lookupTool: toolLookup(tools),
        workspaceRoot: TEST_WORKSPACE_ROOT,
      });
      const session = await createSessionWith(
        plugin,
        tools,
        scriptedProvider([
          [{ type: "toolCall", id: "t1", toolName: "Write", args: { path: "src/a.ts", content: "x" } }],
          [{ type: "text", text: "done" }],
        ]),
      );

      await session.run("write it", undefined, { taskId: "task-1" });

      expect(task.changeEvents).toHaveLength(1);
      expect(task.changeEvents[0]).toMatchObject({ path: "src/a.ts", source: "declared" });
      expect(task.calls).toEqual([
        "acquireMutationContext",
        "readExpectedVersion",
        "requireAttribution",
        "captureBefore",
        "captureAfter",
        "append",
        "dispose",
      ]);
    });

    it("is blocked while attribution is pending", async () => {
      const task = fakeTaskRuntime();
      await seedPendingAttribution(task, ["src/a.ts"]);
      let executed = 0;
      const tools = [undeclaredWriteTool(task, { onExecute: () => { executed += 1; } })];
      const plugin = taskPlugin({
        port: task,
        lookupTool: toolLookup(tools),
        workspaceRoot: TEST_WORKSPACE_ROOT,
      });
      const session = await createSessionWith(
        plugin,
        tools,
        scriptedProvider([
          [{ type: "toolCall", id: "t1", toolName: "Write", args: { path: "src/b.ts", content: "x" } }],
          [{ type: "text", text: "done" }],
        ]),
      );

      await session.run("write it", undefined, { taskId: "task-1" });

      expect(executed).toBe(0);
      const blockedResult = session.history
        .flatMap((message) => message.parts)
        .find((part) => part.type === "toolResult" && part.content.includes("未归属"));
      expect(blockedResult).toMatchObject({ type: "toolResult", isError: true });
      // Seed (acquire/append/dispose) then the blocked invocation — which
      // acquired a context, checked attribution and disposed, but never captured.
      expect(task.calls).toEqual([
        "acquireMutationContext",
        "append",
        "dispose",
        "acquireMutationContext",
        "readExpectedVersion",
        "requireAttribution",
        "dispose",
      ]);
    });

    it("is still skipped when readOnly is authoritative", async () => {
      const task = fakeTaskRuntime();
      let executed = 0;
      const tools: Tool[] = [
        { ...fakeReadTool({ onExecute: () => { executed += 1; } }), sideEffect: undefined },
      ];
      const plugin = taskPlugin({
        port: task,
        lookupTool: toolLookup(tools),
        workspaceRoot: TEST_WORKSPACE_ROOT,
      });
      const session = await createSessionWith(
        plugin,
        tools,
        scriptedProvider([
          [{ type: "toolCall", id: "t1", toolName: "Read", args: {} }],
          [{ type: "text", text: "done" }],
        ]),
      );

      await session.run("read it", undefined, { taskId: "task-1" });

      expect(executed).toBe(1);
      expect(task.calls).toHaveLength(0);
    });
  });
});
