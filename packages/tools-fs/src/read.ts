import fs from "node:fs/promises";
import { resolveWithin, requireString } from "./paths";
import type { Tool, ToolContext } from "@innocencecode/harness-core";

const MAX_LINES = 2000;

/** Read a text file with `cat -n` style line numbers (offset/limit paging). */
export const readTool: Tool = {
  name: "Read",
  description:
    "读取工作区内的文本文件，返回带行号的内容。用 offset/limit 分页，默认最多 " +
    `${MAX_LINES} 行。引用代码时请使用 文件路径:行号 格式。`,
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工作区相对路径或绝对路径" },
      offset: { type: "integer", description: "起始行（1 起），可选" },
      limit: { type: "integer", description: "读取行数，可选" },
    },
    required: ["path"],
  },
  async execute(args, ctx: ToolContext) {
    const target = resolveWithin(ctx.workspaceRoot, requireString(args, "path"));
    const stat = await fs.stat(target);
    if (stat.isDirectory()) throw new Error(`是目录不是文件：${target}`);
    const raw = await fs.readFile(target, "utf8");
    const allLines = raw.split("\n");
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.min(Number(args.limit) || MAX_LINES, MAX_LINES);
    const slice = allLines.slice(offset - 1, offset - 1 + limit);
    const body = slice.map((line, i) => `${offset + i}\t${line}`).join("\n");
    const truncated =
      offset - 1 + limit < allLines.length
        ? `\n[已截断：共 ${allLines.length} 行，用 offset=${offset + limit} 继续]`
        : "";
    return { content: body + truncated || "[空文件]" };
  },
};
