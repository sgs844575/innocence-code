// innocence-plugin:// 协议的 Node 级钉死测试：mock 掉 Electron 的 protocol
// 模块后直接调用捕获的 handler（Response 为 Node 全局，与 protocol.handle
// 消费的形态一致）；fixture 用 mkdtemp 真实文件验证双根 shadow、pluginId
// 恶意形态 403、路径逃逸 403、未命中 404 与 content-type 映射。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { protocol } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}));

import { PLUGIN_SCHEME, handlePluginScheme, registerPluginScheme } from "./protocol";

/** Minimal request shape consumed by the scheme handlers (url only). */
type SchemeHandler = (request: { url: string }) => Response;

const roots: string[] = [];
let userRoot = "";
let builtinRoot = "";

function write(root: string, rel: string, data: string | Uint8Array): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

/** The handler registered for the plugin scheme (latest wiring call). */
function pluginHandler(): SchemeHandler {
  const calls = vi.mocked(protocol.handle).mock.calls;
  const call = calls.find(([scheme]) => scheme === PLUGIN_SCHEME);
  if (!call) throw new Error("plugin scheme handler was not registered");
  return call[1] as unknown as SchemeHandler;
}

const get = (url: string): Response => pluginHandler()({ url });

beforeEach(() => {
  vi.clearAllMocks();
  userRoot = mkdtempSync(path.join(tmpdir(), "ic-plugin-user-"));
  builtinRoot = mkdtempSync(path.join(tmpdir(), "ic-plugin-builtin-"));
  roots.push(userRoot, builtinRoot);

  // User root: shadows "fs" and owns "probe" entirely.
  write(userRoot, path.join("fs", "dist", "index.js"), "export const root = 'user';\n");
  write(userRoot, path.join("probe", "dist", "style.css"), "body { color: red; }\n");
  write(userRoot, path.join("probe", "dist", "app.js"), "export const kind = 'user-js';\n");
  write(userRoot, path.join("probe", "dist", "data.json"), '{"root":"user"}\n');
  write(userRoot, path.join("probe", "dist", "blob.bin"), new Uint8Array([1, 2, 3]));

  // Builtin root: shadowed for "fs", sole provider of "onlybuiltin".
  write(builtinRoot, path.join("fs", "dist", "index.js"), "export const root = 'builtin';\n");
  write(builtinRoot, path.join("onlybuiltin", "dist", "data.json"), '{"ok":true}\n');
  write(builtinRoot, path.join("onlybuiltin", "dist", "mod.mjs"), "export const kind = 'mjs';\n");

  handlePluginScheme({ userRoot, builtinRoot });
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("registerPluginScheme", () => {
  it("registers the scheme with standard/secure/supportFetchAPI/corsEnabled privileges", () => {
    registerPluginScheme();
    expect(vi.mocked(protocol.registerSchemesAsPrivileged)).toHaveBeenCalledWith([
      {
        scheme: PLUGIN_SCHEME,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
        },
      },
    ]);
  });
});

describe("handlePluginScheme", () => {
  it("registers a handler for the plugin scheme", () => {
    expect(vi.mocked(protocol.handle).mock.calls.some(([scheme]) => scheme === PLUGIN_SCHEME)).toBe(
      true,
    );
  });

  it("user root shadows the builtin root for the same plugin id", async () => {
    const res = get("innocence-plugin://fs/dist/index.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("export const root = 'user';\n");
  });

  it("falls back to the builtin root when only builtin has the file", async () => {
    const res = get(`${PLUGIN_SCHEME}://onlybuiltin/dist/data.json`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}\n');
  });

  it("returns 404 when neither root has the file", () => {
    expect(get(`${PLUGIN_SCHEME}://ghost/dist/index.js`).status).toBe(404);
  });

  it("returns 404 for a plugin id without a file path (directory itself)", () => {
    expect(get(`${PLUGIN_SCHEME}://fs`).status).toBe(404);
  });

  it.each([
    ["dot-prefixed host", `${PLUGIN_SCHEME}://../a/b`],
    ["percent-encoded slash in host", `${PLUGIN_SCHEME}://a%2Fb/dist/index.js`],
    ["percent-encoded drive letter", `${PLUGIN_SCHEME}://C%3A%5Cx/dist/index.js`],
    ["raw drive letter (unparseable URL)", `${PLUGIN_SCHEME}://C:\\x`],
  ])("rejects malicious plugin id (%s) with 403", (_label, url) => {
    expect(get(url).status).toBe(403);
  });

  it("rejects an encoded traversal file path that escapes the root with 403", () => {
    // Literal and %2e-encoded dot segments are already collapsed by the URL
    // parser; an encoded separator survives decoding, so the resolved-path
    // containment guard must catch it.
    expect(get(`${PLUGIN_SCHEME}://fs/..%2f..%2fsecret.js`).status).toBe(403);
  });

  it.each([
    [`${PLUGIN_SCHEME}://probe/dist/app.js`, "text/javascript; charset=utf-8"],
    [`${PLUGIN_SCHEME}://onlybuiltin/dist/mod.mjs`, "text/javascript; charset=utf-8"],
    [`${PLUGIN_SCHEME}://probe/dist/style.css`, "text/css; charset=utf-8"],
    [`${PLUGIN_SCHEME}://probe/dist/data.json`, "application/json; charset=utf-8"],
    [`${PLUGIN_SCHEME}://probe/dist/blob.bin`, "application/octet-stream"],
  ])("maps content-type for %s", async (url, type) => {
    const res = get(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
  });

  it("opts responses into credential-free cross-origin reads (renderer origin differs)", async () => {
    const ok = get(`${PLUGIN_SCHEME}://fs/dist/index.js`);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    const miss = get(`${PLUGIN_SCHEME}://ghost/dist/index.js`);
    expect(miss.headers.get("access-control-allow-origin")).toBe("*");
  });
});
