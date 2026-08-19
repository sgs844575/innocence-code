import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createExecutionScope, PluginRegistry, type ToolContext } from "@innocencecode/harness-core";
import { todoPlugin, todoWriteTool } from "../src/index";

let root: string;
const ctx = (): ToolContext => ({
  workspaceRoot: root,
  signal: new AbortController().signal,
  log: () => {},
  scope: createExecutionScope("TodoWrite"),
});

const item = (content: string, status = "pending", priority = "medium") => ({
  content,
  status,
  priority,
});

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-todo-"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("TodoWrite tool metadata", () => {
  it("declares name, write-ness, sideEffect none and a todos array schema", () => {
    expect(todoWriteTool.name).toBe("TodoWrite");
    expect(todoWriteTool.readOnly).toBe(false);
    expect(todoWriteTool.sideEffect).toBe("none");
    const params = todoWriteTool.parameters as Record<string, any>;
    expect(params.type).toBe("object");
    expect(params.required).toEqual(["todos"]);
    const todos = params.properties.todos;
    expect(todos.type).toBe("array");
    expect(todos.items.required).toEqual(["content", "status", "priority"]);
    expect(todos.items.properties.status.enum).toEqual(["pending", "in_progress", "completed"]);
    expect(todos.items.properties.priority.enum).toEqual(["high", "medium", "low"]);
  });
});

describe("validateArgs rejects malformed todos", () => {
  it("requires a todos array", async () => {
    await expect(todoWriteTool.validateArgs?.({})).rejects.toThrow("todos");
    await expect(todoWriteTool.validateArgs?.({ todos: "nope" })).rejects.toThrow("todos");
  });

  it("rejects bad content, status and priority naming the field, not the value", async () => {
    await expect(todoWriteTool.validateArgs?.({ todos: [{ status: "pending", priority: "low" }] })).rejects.toThrow("content");
    await expect(
      todoWriteTool.validateArgs?.({ todos: [item("x", "done")] }),
    ).rejects.toThrow("status");
    await expect(
      todoWriteTool.validateArgs?.({ todos: [item("x", "pending", "urgent")] }),
    ).rejects.toThrow("priority");
    await expect(
      todoWriteTool.validateArgs?.({ todos: ["not an object"] }),
    ).rejects.toThrow("todos[0]");
  });

  it("accepts a well-formed list", async () => {
    await expect(
      todoWriteTool.validateArgs?.({ todos: [item("a"), item("b", "in_progress", "high"), item("c", "completed", "low")] }),
    ).resolves.toBeUndefined();
  });
});

describe("persistence policy (permissionResource / persistArgs)", () => {
  it("resource is a constant session-scoped todo write", () => {
    const resource = todoWriteTool.permissionResource(
      { todos: [item("secret-ish content")] },
      ctx(),
    );
    expect(resource).toEqual({ action: "write", kind: "todo", scope: "session" });
    // 与参数无关：清单大小/内容不改变资源
    expect(todoWriteTool.permissionResource({ todos: [] }, ctx())).toEqual(resource);
  });

  it("persistArgs keeps model-authored text but clones and strips via the validated path", () => {
    const todos = [item("任务甲", "in_progress", "high"), item("任务乙")];
    const persisted = todoWriteTool.persistArgs({ todos });
    expect(persisted).toEqual({ todos });
    expect((persisted as { todos: unknown[] }).todos[0]).toMatchObject({
      content: "任务甲",
      status: "in_progress",
      priority: "high",
    });
  });

  it("persistArgs shares no nested references with raw args and drops extra fields", () => {
    const raw = [
      { content: "任务", status: "pending", priority: "low", extra: "junk", nested: { deep: true } },
    ];
    const persisted = todoWriteTool.persistArgs({ todos: raw }) as { todos: unknown[] };
    expect(persisted.todos).not.toBe(raw);
    expect(persisted.todos[0]).not.toBe(raw[0]);
    expect(persisted.todos[0]).toEqual({ content: "任务", status: "pending", priority: "low" });
    expect(JSON.stringify(persisted)).not.toContain("junk");
  });
});

describe("execute semantics", () => {
  it("echoes the current list as a count summary", async () => {
    const r = await todoWriteTool.execute(
      { todos: [item("分析需求", "in_progress", "high"), item("写测试"), item("实现", "pending", "low")] },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("3 项");
    expect(r.content).toContain("1 进行中");
    expect(r.content).toContain("2 待办");
  });

  it("whole-replaces: the echo reflects only the new list, not prior calls", async () => {
    await todoWriteTool.execute({ todos: [item("旧任务一"), item("旧任务二"), item("旧任务三")] }, ctx());
    const r = await todoWriteTool.execute({ todos: [item("唯一新任务", "in_progress", "high")] }, ctx());
    expect(r.content).toContain("1 项");
    expect(r.content).toContain("唯一新任务");
    expect(r.content).not.toContain("旧任务一");
  });

  it("empty list clears the checklist", async () => {
    const r = await todoWriteTool.execute({ todos: [] }, ctx());
    expect(r.content).toContain("0 项");
  });

  it("never touches the workspace directory", async () => {
    await todoWriteTool.execute(
      { todos: [item("纯会话状态", "in_progress", "high")] },
      ctx(),
    );
    const entries = await fs.readdir(root);
    expect(entries).toEqual([]);
  });
});

describe("input limits", () => {
  it("schema caps the todos array at maxItems 100", () => {
    const params = todoWriteTool.parameters as Record<string, any>;
    expect(params.properties.todos.maxItems).toBe(100);
  });

  it("rejects more than 100 todos, naming the field not the values", async () => {
    const todos = Array.from({ length: 101 }, (_, i) => item(`任务 ${i}`));
    await expect(todoWriteTool.validateArgs?.({ todos })).rejects.toThrow("todos");
    const boundary = Array.from({ length: 100 }, (_, i) => item(`任务 ${i}`));
    await expect(todoWriteTool.validateArgs?.({ todos: boundary })).resolves.toBeUndefined();
  });

  it("echo truncates overlong content instead of rejecting", async () => {
    const long = "长".repeat(600);
    await expect(todoWriteTool.validateArgs?.({ todos: [item(long)] })).resolves.toBeUndefined();
    const r = await todoWriteTool.execute({ todos: [item(long)] }, ctx());
    expect(r.content).toContain("长".repeat(500));
    expect(r.content).toContain("…");
    expect(r.content).not.toContain(long);
  });
});

describe("todoPlugin", () => {
  it("registers TodoWrite through the fail-closed registry", async () => {
    expect(todoPlugin.name).toBe("todoPlugin");
    const reg = new PluginRegistry();
    await reg.load([todoPlugin]);
    expect([...reg.tools.keys()]).toEqual(["TodoWrite"]);
    const spec = reg.toolSpecs().find((s) => s.name === "TodoWrite");
    expect(spec?.parameters.type).toBe("object");
  });
});
