import fs from "node:fs/promises";
import { resolveWithin, requireString } from "./paths";
import type { Tool, ToolContext } from "@innocencecode/harness-core";

/** Exact-string replacement with uniqueness enforcement (like ZCode's Edit). */
export const editTool: Tool = {
  name: "Edit",
  description:
    "对文件做精确字符串替换。old_string 必须在文件中唯一，否则报错；" +
    "多处替换需传 replace_all。修改前建议先 Read 确认原文。",
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工作区相对路径或绝对路径" },
      old_string: { type: "string", description: "要替换的原文（含缩进，须唯一）" },
      new_string: { type: "string", description: "替换后的文本" },
      replace_all: { type: "boolean", description: "替换所有出现处，默认 false" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(args, ctx: ToolContext) {
    const target = resolveWithin(ctx.workspaceRoot, requireString(args, "path"));
    const oldString = requireString(args, "old_string");
    const newString = requireString(args, "new_string");
    const replaceAll = args.replace_all === true;

    const current = await fs.readFile(target, "utf8");
    const count = current.split(oldString).length - 1;
    if (count === 0) {
      throw new Error("old_string 在文件中不存在，请先 Read 确认原文（含缩进）");
    }
    if (count > 1 && !replaceAll) {
      throw new Error(`old_string 出现 ${count} 次，不唯一；请补充上下文使其唯一，或传 replace_all: true`);
    }

    const next = replaceAll
      ? current.split(oldString).join(newString)
      : current.replace(oldString, newString);
    await fs.writeFile(target, next, "utf8");
    return {
      content: `已替换 ${replaceAll ? count : 1} 处：${requireString(args, "path")}`,
    };
  },
};
