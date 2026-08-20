// Tests for the ExternalEditor launcher — accepts only a validated
// route-relative path (+ line/column), resolves it against the bridge's route
// root, and spawns the user-configured editor with an argument array (never a
// shell string). Uses a fake spawn; no Electron.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createExternalEditor, type EditorProcess, type EditorSpawn } from "./externalEditor";

let storage: string;

beforeAll(async () => {
  storage = await fs.mkdtemp(path.join(os.tmpdir(), "external-editor-test-"));
  await fs.mkdir(path.join(storage, "route", "src"), { recursive: true });
  await fs.writeFile(path.join(storage, "route", "src", "a.ts"), "const needle = 1;\n");
  await fs.writeFile(path.join(storage, "outside.txt"), "secret\n");
});

afterAll(async () => {
  await fs.rm(storage, { recursive: true, force: true });
});

type Listener = (arg?: any) => void;

class FakeProcess implements EditorProcess {
  spawned: { file: string; args: string[]; options: Record<string, unknown> };
  killed = false;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(spawned: { file: string; args: string[]; options: Record<string, unknown> }) {
    this.spawned = spawned;
  }
  on(event: "error", cb: (error: Error) => void): this;
  on(event: "spawn", cb: () => void): this;
  on(event: string, cb: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    return this;
  }
  kill(): void {
    this.killed = true;
  }
  /** Test hook: the editor process actually started. */
  emitSpawn(): void {
    for (const cb of this.listeners.get("spawn") ?? []) cb();
  }
  emitError(error: Error): void {
    for (const cb of this.listeners.get("error") ?? []) cb(error);
  }
}

let spawnFn: Mock<EditorSpawn>;
let procs: FakeProcess[];
let getEditorCommand: Mock<() => string | undefined>;

beforeEach(() => {
  procs = [];
  spawnFn = vi.fn(
    (
      file: string,
      args: string[],
      options: { detached: true; shell: false; stdio: "ignore" },
    ) => {
      const proc = new FakeProcess({ file, args, options });
      procs.push(proc);
      return proc;
    },
  );
  getEditorCommand = vi.fn(() => "code");
});

function makeEditor(overrides?: { command?: string; root?: string }) {
  return createExternalEditor({
    resolveRouteRoot: vi.fn(() => overrides?.root ?? path.join(storage, "route")),
    getEditorCommand: vi.fn(() => overrides?.command ?? "code"),
    spawn: spawnFn,
  });
}

describe("externalEditor launch", () => {
  it("searches and opens only files in the active route", async () => {
    const editor = makeEditor();
    const pending = editor.open({ taskId: "t1", routeId: "r1", relativePath: "src/a.ts", line: 12 });
    await vi.waitFor(() => expect(procs.length).toBe(1)); // spawn lands after fs validation
    procs[0].emitSpawn();
    await expect(pending).resolves.toMatchObject({ launched: true });
  });

  it("spawns the configured command with an argument array, no shell string", async () => {
    const editor = makeEditor();
    const pending = editor.open({ taskId: "t1", routeId: "r1", relativePath: "src/a.ts", line: 12, column: 4 });
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));
    const [file, args, options] = spawnFn.mock.calls[0] as unknown as [
      string,
      string[],
      { shell: boolean },
    ];
    expect(file).toBe("code");
    expect(Array.isArray(args)).toBe(true);
    expect(options.shell).toBe(false);
    // line/column ride along as path:line:column — the generic convention
    // shared by VS Code / Cursor / Sublime style CLIs.
    expect(args).toEqual(
      expect.arrayContaining([path.join(storage, "route", "src", "a.ts") + ":12:4"]),
    );
    procs[0].emitSpawn();
    await pending;
  });

  it("passes the bare absolute path when no line is given", async () => {
    const editor = makeEditor();
    const pending = editor.open({ taskId: "t1", routeId: "r1", relativePath: "src/a.ts" });
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));
    const args = spawnFn.mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining([path.join(storage, "route", "src", "a.ts")]));
    expect(args.some((a) => /:\d+(?::\d+)?$/.test(a))).toBe(false);
    procs[0].emitSpawn();
    await pending;
  });

  it("keeps extra tokens of a quoted command as leading arguments", async () => {
    const editor = makeEditor({ command: '"C:/Program Files/Editor/editor.exe" --wait' });
    const pending = editor.open({ taskId: "t1", routeId: "r1", relativePath: "src/a.ts" });
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));
    const [file, args] = spawnFn.mock.calls[0];
    expect(file).toBe("C:/Program Files/Editor/editor.exe");
    expect(args[0]).toBe("--wait");
    procs[0].emitSpawn();
    await pending;
  });
});

describe("externalEditor validation", () => {
  it("rejects a path outside the active route", async () => {
    const editor = makeEditor();
    await expect(
      editor.open({ taskId: "t1", routeId: "r1", relativePath: "../outside.txt" }),
    ).rejects.toThrow("outside workspace");
  });

  it("rejects absolute paths and drive letters", async () => {
    const editor = makeEditor();
    await expect(
      editor.open({ taskId: "t1", routeId: "r1", relativePath: "C:/Windows/notepad.exe" }),
    ).rejects.toThrow("outside workspace");
  });

  it("rejects an unknown task/route (ownership)", async () => {
    const editor = createExternalEditor({
      resolveRouteRoot: vi.fn(() => undefined),
      getEditorCommand,
      spawn: spawnFn,
    });
    await expect(editor.open({ taskId: "t1", routeId: "r9", relativePath: "src/a.ts" })).rejects.toThrow(
      "unknown task/route",
    );
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("rejects when no editor command is configured", async () => {
    const editor = makeEditor({ command: "" });
    await expect(editor.open({ taskId: "t1", routeId: "r1", relativePath: "src/a.ts" })).rejects.toThrow(
      /editor command is not configured/i,
    );
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("resolves launched:false with the error when the spawn fails", async () => {
    const editor = makeEditor();
    const pending = editor.open({ taskId: "t1", routeId: "r1", relativePath: "src/a.ts" });
    await vi.waitFor(() => expect(procs.length).toBe(1));
    procs[0].emitError(Object.assign(new Error("spawn code ENOENT"), { code: "ENOENT" }));
    const result = await pending;
    expect(result.launched).toBe(false);
    expect(result.error).toMatch(/ENOENT/);
  });
});
