import {
  sha256Hex,
  type HarnessPlugin,
  type Tool,
  type ToolContext,
} from "@innocencecode/harness-core";

export type AgentType = "explore" | "general";

const AGENT_PROMPTS: Record<AgentType, string> = {
  explore:
    "你是一个只读研究代理。你只能使用只读工具（读文件/搜索），绝不修改任何文件。" +
    "你的任务是深入研究用户给出的问题，返回一份简明、信息密集的结论报告" +
    "（关键发现、涉及的文件与行号、值得注意的风险）。不要寒暄。",
  general:
    "你是一个通用任务代理。在工具允许的范围内完成任务，返回简明的最终报告。" +
    "权限被拒时不要重试同一操作。不要寒暄。",
};

/** Task tool: delegates a scoped job to an isolated nested agent session. */
export const taskTool: Tool = {
  name: "Task",
  description:
    "派生一个隔离子代理去完成一项独立任务，适合并行研究和探索（子代理的中间过程不占用当前上下文）。" +
    "agentType: explore=只读研究, general=全能。prompt 里给足自包含的上下文和目标。",
  readOnly: false,
  sideEffect: "unknown",
  parameters: {
    type: "object",
    properties: {
      agentType: { type: "string", enum: ["explore", "general"], description: "子代理类型" },
      description: { type: "string", description: "一句话任务摘要" },
      prompt: { type: "string", description: "自包含的任务描述（目标、范围、期望产出）" },
    },
    required: ["agentType", "prompt"],
  },
  async validateArgs(args) {
    const prompt = args.prompt;
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new Error("缺少必填参数 prompt（自包含的任务描述）");
    }
  },
  permissionResource(args) {
    // 资源只标识代理类型；prompt 内容绝不进入资源。
    return {
      action: "spawn",
      kind: "agent",
      scope: args.agentType === "general" ? "general" : "explore",
    };
  },
  persistArgs(args) {
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    // 保存代理类型和 prompt 哈希；prompt/description 原文不持久化。
    return {
      agentType: args.agentType === "general" ? "general" : "explore",
      promptSha256: sha256Hex(prompt),
    };
  },
  async execute(args, ctx: ToolContext) {
    const agentType = args.agentType === "general" ? "general" : "explore";
    const prompt = args.prompt;
    const description = args.description;
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new Error("缺少必填参数 prompt（自包含的任务描述）");
    }
    if (!ctx.subagent) {
      return {
        content: "当前宿主不支持子代理（缺少 spawner）",
        isError: true,
      };
    }
    const header = typeof description === "string" && description ? `【${description}】\n` : "";
    const result = await ctx.subagent.run({
      systemPrompt: AGENT_PROMPTS[agentType],
      tools: agentType === "explore" ? "readOnly" : "all",
      prompt,
      signal: ctx.signal,
    });
    return {
      content:
        (header + result.finalText).trim() || "[子代理没有产出文本]",
    };
  },
};

export const subagentPlugin: HarnessPlugin = {
  name: "plugin-subagent",
  activate(ctx) {
    ctx.registerTool(taskTool);
  },
};
