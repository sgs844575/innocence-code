import fs from "node:fs/promises";
import path from "node:path";
import { resolveWithin, requireString } from "./paths";
import type { Tool, ToolContext } from "@innocencecode/harness-core";

/** Create or overwrite a file (mkdir -p for parent directories). */
export const writeTool: Tool = {
  name: "Write",
  description:
    "创建或覆盖写入一个文本文件（整体覆盖，不是追加）。修改既有文件优先用 Edit。",
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工作区相对路径或绝对路径" },
      content: { type: "string", description: "完整文件内容" },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx: ToolContext) {
    const target = resolveWithin(ctx.workspaceRoot, requireString(args, "path"));
    const content = requireString(args, "content");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return { content: `已写入 ${path.relative(ctx.workspaceRoot, target) || target}（${content.length} 字符）` };
  },
};
