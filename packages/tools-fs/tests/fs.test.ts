import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "@innocencecode/harness-core";
import { editTool } from "../src/edit";
import { readTool } from "../src/read";
import { globTool, grepTool } from "../src/search";
import { writeTool } from "../src/write";
import { resolveWithin } from "../src/paths";

let root: string;
const ctx = (): ToolContext => ({
  workspaceRoot: root,
  signal: new AbortController().signal,
  log: () => {},
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
    const { fsPlugin } = await import("../src/index");
    const { PluginRegistry } = await import("@innocencecode/harness-core");
    const reg = new PluginRegistry();
    await reg.load([fsPlugin]);
    expect([...reg.tools.keys()].sort()).toEqual(["Edit", "Glob", "Grep", "Read", "Write"]);
    for (const tool of reg.tools.values()) {
      expect(tool.readOnly).toBeDefined();
      expect(tool.parameters.type).toBe("object");
    }
  });
});
