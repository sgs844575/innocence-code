import fs from "node:fs";
import path from "node:path";
import { matchGlob } from "@innocencecode/harness-core";
import { resolveWithin, requireString, walkFiles } from "./paths";
import type { Tool, ToolContext } from "@innocencecode/harness-core";

const FILE_LIMIT = 500;
const MATCH_LIMIT = 200;

function listWorkspaceFiles(ctx: ToolContext, subDir?: string): string[] {
  const base = subDir ? resolveWithin(ctx.workspaceRoot, subDir) : ctx.workspaceRoot;
  const files: string[] = [];
  walkFiles(ctx.workspaceRoot, base, files, FILE_LIMIT);
  return files;
}

/** Find files by glob pattern, e.g. `src` + double-star + `.ts`. */
export const globTool: Tool = {
  name: "Glob",
  description: "按 glob 模式查找工作区文件，如 `src/**/*.ts`。返回相对路径列表。",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "glob 模式，支持 ** * ? {a,b}" },
      path: { type: "string", description: "限定搜索的子目录，可选" },
    },
    required: ["pattern"],
  },
  async execute(args, ctx: ToolContext) {
    const pattern = requireString(args, "pattern");
    const subDir = typeof args.path === "string" ? args.path : undefined;
    const files = listWorkspaceFiles(ctx, subDir);
    const hits = files.filter((f) => matchGlob(pattern, f));
    if (hits.length === 0) return { content: "没有匹配的文件。" };
    return {
      content:
        hits.join("\n") + (hits.length >= FILE_LIMIT ? `\n[已达 ${FILE_LIMIT} 条上限]` : ""),
    };
  },
};

/** Regex search across workspace files, `file:line: text` output. */
export const grepTool: Tool = {
  name: "Grep",
  description:
    "在工作区文件中做正则搜索，返回 `文件:行号: 内容`。可用 glob 参数过滤文件名。",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式" },
      glob: { type: "string", description: "文件名 glob 过滤，如 *.ts，可选" },
      path: { type: "string", description: "限定搜索的子目录，可选" },
    },
    required: ["pattern"],
  },
  async execute(args, ctx: ToolContext) {
    let regex: RegExp;
    try {
      regex = new RegExp(requireString(args, "pattern"), "u");
    } catch (err) {
      throw new Error(`无效正则：${err instanceof Error ? err.message : err}`);
    }
    const globFilter = typeof args.glob === "string" ? args.glob : undefined;
    const subDir = typeof args.path === "string" ? args.path : undefined;
    const files = listWorkspaceFiles(ctx, subDir);

    const hits: string[] = [];
    for (const rel of files) {
      if (hits.length >= MATCH_LIMIT) break;
      if (globFilter && !matchGlob(globFilter, path.posix.basename(rel))) continue;
      let content: string;
      try {
        const stat = fs.statSync(path.join(ctx.workspaceRoot, rel));
        if (stat.size > 2_000_000) continue; // skip huge files
        content = fs.readFileSync(path.join(ctx.workspaceRoot, rel), "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && hits.length < MATCH_LIMIT; i++) {
        if (regex.test(lines[i])) {
          hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    }
    if (hits.length === 0) return { content: "没有匹配行。" };
    return {
      content:
        hits.join("\n") + (hits.length >= MATCH_LIMIT ? `\n[已达 ${MATCH_LIMIT} 条上限]` : ""),
    };
  },
};
