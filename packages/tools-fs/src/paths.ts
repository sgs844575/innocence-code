import fs from "node:fs";
import path from "node:path";

/**
 * Resolves a user/model-supplied path against the workspace root and refuses
 * anything that escapes it (../ traversal, absolute paths outside).
 */
export function resolveWithin(root: string, target: string): string {
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
  const rel = path.relative(path.resolve(root), abs);
  if (rel === "" || rel === ".") return path.resolve(root);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`路径越出工作区：${target}`);
  }
  return abs;
}

/** Reads required string arg, throws a tool-friendly error when missing. */
export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`缺少必填参数 ${key}（字符串）`);
  }
  return v;
}

/**
 * Canonical workspace-relative POSIX path for permission resources and
 * persisted args. Rejects escapes the same way resolveWithin does.
 */
export function workspaceScope(root: string, target: string): string {
  const abs = resolveWithin(root, target);
  const rel = path.relative(path.resolve(root), abs);
  return (rel === "" ? "." : rel).split(path.sep).join("/");
}

/** Directories skipped while walking the workspace. */
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".vite",
  "out",
  "dist",
  "build",
  ".innocence",
]);

/** Recursively lists workspace-relative file paths (bounded). */
export function walkFiles(root: string, dir: string, out: string[], limit: number): void {
  if (out.length >= limit) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(root, full, out, limit);
    } else if (entry.isFile()) {
      out.push(path.relative(root, full).replace(/\\/g, "/"));
    }
  }
}
