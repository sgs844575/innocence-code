import type { HarnessPlugin, Tool } from "@innocencecode/harness-core";

const STATUS_VALUES = ["pending", "in_progress", "completed"] as const;
const PRIORITY_VALUES = ["high", "medium", "low"] as const;

/** 输入上限：清单条数（校验拒绝）与单条回显长度（回显截断）。 */
const MAX_TODOS = 100;
const MAX_CONTENT_ECHO_CHARS = 500;

export type TodoStatus = (typeof STATUS_VALUES)[number];
export type TodoPriority = (typeof PRIORITY_VALUES)[number];

export interface TodoItem {
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

const STATUS_LABEL: Record<TodoStatus, string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "已完成",
};

/**
 * Parses and validates the raw todos array. Throws name the failing field
 * (never its content) — tool errors enter history/audit unredacted.
 */
function requireTodos(args: Record<string, unknown>): TodoItem[] {
  const todos = args.todos;
  if (!Array.isArray(todos)) {
    throw new Error("缺少必填参数 todos（数组）");
  }
  if (todos.length > MAX_TODOS) {
    throw new Error(`todos 条数超过上限 ${MAX_TODOS}`);
  }
  return todos.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`todos[${i}] 必须是对象`);
    }
    const { content, status, priority } = raw as Record<string, unknown>;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error(`todos[${i}].content 必须是非空字符串`);
    }
    if (!STATUS_VALUES.includes(status as TodoStatus)) {
      throw new Error(`todos[${i}].status 必须是 ${STATUS_VALUES.join(" / ")}`);
    }
    if (!PRIORITY_VALUES.includes(priority as TodoPriority)) {
      throw new Error(`todos[${i}].priority 必须是 ${PRIORITY_VALUES.join(" / ")}`);
    }
    return { content, status: status as TodoStatus, priority: priority as TodoPriority };
  });
}

/** Count summary echoed to the model, e.g. "3 项：1 进行中 / 2 待办". */
export function todoSummary(todos: readonly TodoItem[]): string {
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  const pending = todos.filter((t) => t.status === "pending").length;
  return `${todos.length} 项：${inProgress} 进行中 / ${pending} 待办`;
}

/** Echo copy of an item's content — overlong input truncates with an ellipsis marker. */
function echoContent(content: string): string {
  return content.length > MAX_CONTENT_ECHO_CHARS
    ? `${content.slice(0, MAX_CONTENT_ECHO_CHARS)}…（超长截断）`
    : content;
}

/**
 * Session-scoped todo list tool. The list lives purely in the transcript via
 * persisted tool-call args — each call whole-replaces the previous list and
 * nothing is ever written to the workspace.
 */
export const todoWriteTool: Tool = {
  name: "TodoWrite",
  description:
    "维护当前任务清单：整体替换 todos 数组（content/status/priority）。计划与全量 agent 用它跟踪执行。",
  readOnly: false,
  sideEffect: "none",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        maxItems: MAX_TODOS,
        description: "完整清单（整体替换语义，非增量追加）",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "任务内容" },
            status: { type: "string", enum: [...STATUS_VALUES], description: "任务状态" },
            priority: { type: "string", enum: [...PRIORITY_VALUES], description: "优先级" },
          },
          required: ["content", "status", "priority"],
        },
      },
    },
    required: ["todos"],
  },
  async validateArgs(args) {
    requireTodos(args);
  },
  permissionResource() {
    // 纯会话状态：清单只存在于 transcript，资源恒为 session 级 todo 写入。
    return { action: "write", kind: "todo", scope: "session" };
  },
  persistArgs(args) {
    // 模型自拟任务文本，持久化安全：复用已验证路径重建对象数组——
    // 剥离多余字段，且与 raw args 不共享任何嵌套引用。
    return { todos: requireTodos(args) };
  },
  async execute(args) {
    const todos = requireTodos(args);
    if (todos.length === 0) {
      return { content: "清单已清空（0 项）" };
    }
    const lines = todos.map((t, i) => `${i + 1}. [${STATUS_LABEL[t.status]}] ${echoContent(t.content)}`);
    return { content: [`已记录 ${todoSummary(todos)}`, ...lines].join("\n") };
  },
};

/** Session-todo tools plugin — registers TodoWrite. */
export const todoPlugin: HarnessPlugin = {
  name: "todoPlugin",
  activate(ctx) {
    ctx.registerTool(todoWriteTool);
  },
};
