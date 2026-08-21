import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Context } from "@innocencecode/kernel";
import { ToolsPlugin } from "@innocencecode/harness-tools";
import { createExecutionScope, sha256Hex, type ToolContext } from "@innocencecode/harness-tools";
import { editTool } from "../src/edit";
import { readTool } from "../src/read";
import { globTool, grepTool } from "../src/search";
import { writeTool } from "../src/write";
import { resolveWithin } from "../src/paths";
import { FsPlugin } from "../src/index";

/** Mounts the plugin on a bare kernel context (tools spine service only). */
async function mountFs(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(ToolsPlugin);
  await ctx.plugin(FsPlugin);
  return ctx;
}

let root: string;
const ctx = (toolName = "Read"): ToolContext => ({
  workspaceRoot: root,
  signal: new AbortController().signal,
  log: () => {},
  scope: createExecutionScope(toolName),
});

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-fs-"));
  await fs.mkdir(path.join(root, "src", "nested"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "junk"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.ts"), "line1\nline2\nline3\n", "utf8");
  await fs.writeFile(path.join(root, "src", "nested", "b.ts"), "const x = 42;\n", "utf8");
  await fs.writeFile(path.join(root, "src", "c.md"), "# doc\n", "utf8");
  await fs.writeFile(path.join(root, "node_modules", "junk", "x.ts"), "junk\n", "utf8");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("resolveWithin", () => {
  it("resolves relative paths and rejects escapes", () => {
    expect(resolveWithin(root, "src/a.ts")).toBe(path.join(root, "src", "a.ts"));
    expect(resolveWithin(root, "./src/../src/a.ts")).toBe(path.join(root, "src", "a.ts"));
    expect(() => resolveWithin(root, "../outside.txt")).toThrow("越出工作区");
    expect(() => resolveWithin(root, path.join(root, "..", "x"))).toThrow("越出工作区");
  });

  it("accepts absolute paths inside the root", () => {
    expect(resolveWithin(root, path.join(root, "src", "a.ts"))).toBe(
      path.join(root, "src", "a.ts"),
    );
  });
});

describe("Read tool", () => {
  it("returns numbered lines with paging hint", async () => {
    const r = await readTool.execute({ path: "src/a.ts", limit: 2 }, ctx());
    expect(r.content).toContain("1\tline1");
    expect(r.content).toContain("2\tline2");
    expect(r.content).toContain("offset=3");
  });

  it("rejects directories and missing args", async () => {
    await expect(readTool.execute({ path: "src" }, ctx())).rejects.toThrow("目录");
    await expect(readTool.execute({}, ctx())).rejects.toThrow("path");
    await expect(readTool.execute({ path: "../x" }, ctx())).rejects.toThrow("越出工作区");
  });
});

describe("Write tool", () => {
  it("creates files with parent dirs", async () => {
    await writeTool.execute(
      { path: "docs/deep/new.txt", content: "hello" },
      ctx(),
    );
    const stat = await fs.stat(path.join(root, "docs", "deep", "new.txt"));
    expect(stat.isFile()).toBe(true);
  });
});

describe("Edit tool", () => {
  it("replaces a unique match and enforces uniqueness", async () => {
    await writeTool.execute({ path: "e.txt", content: "aa\nbb\naa\n" }, ctx());
    const ok = await editTool.execute(
      { path: "e.txt", old_string: "bb", new_string: "BB" },
      ctx(),
    );
    expect(ok.content).toContain("已替换 1 处");
    await expect(
      editTool.execute({ path: "e.txt", old_string: "aa", new_string: "x" }, ctx()),
    ).rejects.toThrow("不唯一");
    const all = await editTool.execute(
      { path: "e.txt", old_string: "aa", new_string: "AA", replace_all: true },
      ctx(),
    );
    expect(all.content).toContain("2 处");
    await expect(
      editTool.execute({ path: "e.txt", old_string: "zz", new_string: "x" }, ctx()),
    ).rejects.toThrow("不存在");
  });
});

describe("Glob / Grep tools", () => {
  it("glob finds by pattern and skips node_modules", async () => {
    const r = await globTool.execute({ pattern: "src/**/*.ts" }, ctx());
    expect(r.content).toContain("src/a.ts");
    expect(r.content).toContain("src/nested/b.ts");
    expect(r.content).not.toContain("junk");
    const none = await globTool.execute({ pattern: "**/*.zzz" }, ctx());
    expect(none.content).toContain("没有匹配");
  });

  it("grep matches with file:line and glob filter", async () => {
    const r = await grepTool.execute({ pattern: "42", glob: "*.ts" }, ctx());
    expect(r.content).toContain("src/nested/b.ts:1:");
    const filtered = await grepTool.execute({ pattern: "line", glob: "*.md" }, ctx());
    expect(filtered.content).toContain("没有匹配行");
  });
});

describe("tools as plugin", () => {
  it("registers all five tools with sane metadata", async () => {
    const ctx = await mountFs();
    expect(ctx.tools.specs().map((s) => s.name).sort()).toEqual(["Edit", "Glob", "Grep", "Read", "Write"]);
    for (const spec of ctx.tools.specs()) {
      expect(spec.readOnly).toBeDefined();
      expect(spec.parameters.type).toBe("object");
    }
  });

  it("declares the coarse side-effect class of every tool", async () => {
    const ctx = await mountFs();
    expect(ctx.tools.get("Read")).toMatchObject({ sideEffect: "none" });
    expect(ctx.tools.get("Glob")).toMatchObject({ sideEffect: "none" });
    expect(ctx.tools.get("Grep")).toMatchObject({ sideEffect: "none" });
    expect(ctx.tools.get("Write")).toMatchObject({ sideEffect: "paths" });
    expect(ctx.tools.get("Edit")).toMatchObject({ sideEffect: "paths" });
  });
});

describe("persistence policy (permissionResource / persistArgs)", () => {
  const SECRET = "FS-SECRET-4b6d92aa";

  it("Write persists only path, content length and SHA-256", () => {
    const persisted = writeTool.persistArgs({ path: "src/a.ts", content: `body ${SECRET}` });
    expect(persisted).toMatchObject({
      path: "src/a.ts",
      contentLength: `body ${SECRET}`.length,
      contentSha256: sha256Hex(`body ${SECRET}`),
    });
    expect(JSON.stringify(persisted)).not.toContain(SECRET);
  });

  it("Edit persists only path and the new content's length/digest", () => {
    const persisted = editTool.persistArgs({
      path: "src/a.ts",
      old_string: `old ${SECRET}`,
      new_string: `new ${SECRET}`,
    });
    expect(persisted).toMatchObject({
      path: "src/a.ts",
      contentLength: `new ${SECRET}`.length,
      contentSha256: sha256Hex(`new ${SECRET}`),
    });
    expect(JSON.stringify(persisted)).not.toContain(SECRET);
  });

  it("path resources are canonical and workspace-relative", () => {
    const resource = writeTool.permissionResource(
      { path: path.join(root, "src", "a.ts"), content: "x" },
      ctx("Write"),
    );
    expect(resource).toEqual({ action: "write", kind: "path", scope: "src/a.ts" });

    const readResource = readTool.permissionResource({ path: "./src/../src/a.ts" }, ctx());
    expect(readResource).toEqual({ action: "read", kind: "path", scope: "src/a.ts" });

    const searchResource = grepTool.permissionResource({ pattern: "x", path: "src" }, ctx("Grep"));
    expect(searchResource).toEqual({ action: "read", kind: "search", scope: "src" });
  });

  it("validateArgs rejects malformed args before resources are derived", async () => {
    await expect(writeTool.validateArgs?.({ path: "a" })).rejects.toThrow("content");
    await expect(readTool.validateArgs?.({})).rejects.toThrow("path");
  });

  it("escaping paths are refused at the resource stage (fail-closed)", () => {
    expect(() =>
      writeTool.permissionResource({ path: "../outside.txt", content: "x" }, ctx("Write")),
    ).toThrow("越出工作区");
  });
});
