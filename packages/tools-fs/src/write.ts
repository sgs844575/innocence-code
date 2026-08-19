import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "@innocencecode/harness-core";
import { resolveWithin, requireString, workspaceScope } from "./paths";
import type { Tool, ToolContext } from "@innocencecode/harness-core";

/** Create or overwrite a file (mkdir -p for parent directories). */
export const writeTool: Tool = {
  name: "Write",
  description:
    "创建或覆盖写入一个文本文件（整体覆盖，不是追加）。修改既有文件优先用 Edit。",
  readOnly: false,
  sideEffect: "paths",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工作区相对路径或绝对路径" },
      content: { type: "string", description: "完整文件内容" },
    },
    required: ["path", "content"],
  },
  async validateArgs(args) {
    requireString(args, "path");
    requireString(args, "content");
  },
  permissionResource(args, ctx: ToolContext) {
    return {
      action: "write",
      kind: "path",
      scope: workspaceScope(ctx.workspaceRoot, requireString(args, "path")),
    };
  },
  persistArgs(args) {
    const content = requireString(args, "content");
    // 只保存路径、内容长度和 SHA-256 —— 文件内容绝不持久化。
    return {
      path: args.path,
      contentLength: content.length,
      contentSha256: sha256Hex(content),
    };
  },
  async execute(args, ctx: ToolContext) {
    const target = resolveWithin(ctx.workspaceRoot, requireString(args, "path"));
    const content = requireString(args, "content");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return { content: `已写入 ${path.relative(ctx.workspaceRoot, target) || target}（${content.length} 字符）` };
  },
};
