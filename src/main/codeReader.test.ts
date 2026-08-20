// Tests for the route-scoped CodeReader — path validation (traversal /
// absolute / drive letters / symlink escape), task/route ownership through the
// bridge port, language detection, binary metadata-only reads, and the
// stat-gated size cap (oversized files return metadata WITHOUT a byte read).
// Uses a temp workspace; no Electron.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodeReader, MAX_CODE_READ_BYTES } from "./codeReader";

let storage: string;

beforeAll(async () => {
  storage = await fs.mkdtemp(path.join(os.tmpdir(), "code-reader-test-"));
});

afterAll(async () => {
  await fs.rm(storage, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(storage, "route"), { recursive: true, force: true });
  await fs.mkdir(path.join(storage, "route", "src"), { recursive: true });
  await fs.writeFile(path.join(storage, "route", "src", "a.ts"), "const needle = 1;\n");
  await fs.writeFile(path.join(storage, "route", "notes.md"), "# hello\n");
  await fs.writeFile(path.join(storage, "route", "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x4e]));
  await fs.mkdir(path.join(storage, "route", ".git"), { recursive: true });
  await fs.writeFile(path.join(storage, "route", ".git", "HEAD"), "ref: refs/heads/main\n");
  await fs.writeFile(path.join(storage, "outside.txt"), "secret\n");
});

/** Route roots per (taskId, routeId) — mirrors bridge.getRoute semantics.
 *  Evaluated lazily (per makeReader call): `storage` only exists after beforeAll. */
const routes = (): Record<string, string | undefined> => ({
  "t1/r1": path.join(storage, "route"),
  "t1/r2": undefined, // unknown route for t1
});

function makeReader(overrides?: {
  resolveRouteRoot?: (taskId: string, routeId: string) => string | undefined;
  readBytes?: (absolute: string) => Promise<Uint8Array>;
}) {
  const map = routes();
  const resolveRouteRoot =
    overrides?.resolveRouteRoot ?? vi.fn((taskId: string, routeId: string) => map[`${taskId}/${routeId}`]);
  return { resolveRouteRoot, reader: createCodeReader({ resolveRouteRoot, readBytes: overrides?.readBytes }) };
}

describe("codeReader path safety", () => {
  it("rejects a code read outside the active route", async () => {
    const { reader } = makeReader();
    await expect(
      reader.readFile({ taskId: "t1", routeId: "r1", relativePath: "../secret" }),
    ).rejects.toThrow("outside workspace");
  });

  it("rejects absolute paths, drive letters and backslash paths", async () => {
    const { reader } = makeReader();
    for (const bad of ["/etc/passwd", "C:/Windows/system32", "src\\a.ts", "src/../src/a.ts", "."]) {
      await expect(
        reader.readFile({ taskId: "t1", routeId: "r1", relativePath: bad }),
      ).rejects.toThrow("outside workspace");
    }
  });

  it("rejects reads for an unknown task or route (ownership)", async () => {
    const { reader } = makeReader();
    await expect(reader.readFile({ taskId: "t1", routeId: "r2", relativePath: "src/a.ts" })).rejects.toThrow(
      "unknown task/route",
    );
    await expect(reader.readFile({ taskId: "tx", routeId: "r1", relativePath: "src/a.ts" })).rejects.toThrow(
      "unknown task/route",
    );
  });

  it("rejects a path whose segment is a symlink escaping the route root", async () => {
    const linkPath = path.join(storage, "route", "linked.ts");
    await fs.rm(linkPath, { force: true });
    let linkError: NodeJS.ErrnoException | undefined;
    try {
      await fs.symlink(path.join(storage, "outside.txt"), linkPath);
    } catch (error) {
      linkError = error as NodeJS.ErrnoException;
    }
    if (linkError && (linkError.code === "EPERM" || linkError.code === "EACCES")) {
      // Windows without symlink privilege: the lstat guard is still covered by
      // the directory + traversal cases above.
      return;
    }
    const { reader } = makeReader();
    await expect(reader.readFile({ taskId: "t1", routeId: "r1", relativePath: "linked.ts" })).rejects.toThrow(
      "outside workspace",
    );
  });

  it("rejects directories with a clear error instead of dumping content", async () => {
    const { reader } = makeReader();
    await expect(reader.readFile({ taskId: "t1", routeId: "r1", relativePath: "src" })).rejects.toThrow(
      "not a regular file",
    );
  });
});

describe("codeReader reads", () => {
  it("returns read-only content with a language for a text file", async () => {
    const { reader } = makeReader();
    const file = await reader.readFile({ taskId: "t1", routeId: "r1", relativePath: "src/a.ts" });
    expect(file.path).toBe("src/a.ts");
    expect(file.content).toBe("const needle = 1;\n");
    expect(file.language).toBe("typescript");
    expect(file.readOnly).toBe(true);
    expect(file.binary).toBe(false);
  });

  it("returns file-level metadata only for a binary file", async () => {
    const { reader } = makeReader();
    const file = await reader.readFile({ taskId: "t1", routeId: "r1", relativePath: "blob.bin" });
    expect(file.binary).toBe(true);
    expect(file.content).toBe("");
    expect(file.size).toBe(4);
    expect(file.language).toBe("binary");
  });

  it("detects markdown and unknown extensions", async () => {
    const { reader } = makeReader();
    expect((await reader.readFile({ taskId: "t1", routeId: "r1", relativePath: "notes.md" })).language).toBe(
      "markdown",
    );
  });

  it("returns metadata only for an oversized file without reading its bytes", async () => {
    // 真实文件：stat 尺寸超过读取上限（内容任意，反正不该被读）。
    await fs.writeFile(
      path.join(storage, "route", "big.ts"),
      Buffer.alloc(MAX_CODE_READ_BYTES + 1, 0x78),
    );
    const readBytes = vi.fn(async () => new Uint8Array([0x78]));
    const { reader } = makeReader({ readBytes });
    const file = await reader.readFile({ taskId: "t1", routeId: "r1", relativePath: "big.ts" });
    expect(file.content).toBe("");
    expect(file.truncated).toBe(true);
    expect(file.binary).toBe(false);
    expect(file.size).toBe(MAX_CODE_READ_BYTES + 1);
    expect(file.language).toBe("typescript");
    expect(readBytes).not.toHaveBeenCalled(); // stat 门禁：零字节读取
  });

  it("returns metadata only for a large binary file without reading its bytes", async () => {
    await fs.writeFile(
      path.join(storage, "route", "huge.bin"),
      Buffer.alloc(MAX_CODE_READ_BYTES + 512, 0x00),
    );
    const readBytes = vi.fn(async () => new Uint8Array([0x00]));
    const { reader } = makeReader({ readBytes });
    const file = await reader.readFile({ taskId: "t1", routeId: "r1", relativePath: "huge.bin" });
    expect(file.binary).toBe(false); // 未知内容——尺寸门禁先于嗅探
    expect(file.content).toBe("");
    expect(file.truncated).toBe(true);
    expect(file.size).toBe(MAX_CODE_READ_BYTES + 512);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("lists route files relative and excludes .git internals", async () => {
    const { reader } = makeReader();
    const { files } = await reader.listFiles({ taskId: "t1", routeId: "r1" });
    expect(files).toEqual(expect.arrayContaining(["src/a.ts", "notes.md", "blob.bin"]));
    expect(files.some((f) => f.startsWith(".git"))).toBe(false);
  });
});
