// Tests for the route-scoped CodeSearch — rg invocation with an argument
// array (never a shell string), route-scoped cwd, result/output caps, and the
// clear-error degradation when rg is missing (no silent fallback). Uses a
// fake spawn; no Electron.
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createCodeSearch, type RgProcess, type RgSpawn } from "./codeSearch";

interface RecordedSpawn {
  file: string;
  args: string[];
  options: { cwd: string; shell: false };
}

type Listener = (arg?: any) => void;

class FakeRg implements RgProcess {
  readonly recorded: RecordedSpawn;
  killed = false;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(recorded: RecordedSpawn) {
    this.recorded = recorded;
  }
  private add(key: string, cb: Listener): void {
    const list = this.listeners.get(key) ?? [];
    list.push(cb);
    this.listeners.set(key, list);
  }
  stdout = { on: (_event: "data", cb: (chunk: string) => void) => this.add("stdout", cb) };
  stderr = { on: (_event: "data", cb: (chunk: string) => void) => this.add("stderr", cb) };
  on(event: "error", cb: (error: Error) => void): this;
  on(event: "close", cb: (code: number | null) => void): this;
  on(event: string, cb: Listener): this {
    this.add(event, cb);
    return this;
  }
  kill(): void {
    this.killed = true;
  }
  /** Test hook: pretend rg emitted stdout / errored / exited. */
  emitStdout(chunk: string): void {
    for (const cb of this.listeners.get("stdout") ?? []) cb(chunk);
  }
  emitError(error: Error): void {
    for (const cb of this.listeners.get("error") ?? []) cb(error);
  }
  emitClose(code: number | null): void {
    for (const cb of this.listeners.get("close") ?? []) cb(code);
  }
}

let spawns: FakeRg[];
let spawnFn: Mock<RgSpawn>;
let resolveRouteRoot: Mock<(taskId: string, routeId: string) => string | undefined>;

beforeEach(() => {
  spawns = [];
  spawnFn = vi.fn((file: string, args: string[], options: { cwd: string; shell: false }) => {
    const proc = new FakeRg({ file, args, options });
    spawns.push(proc);
    return proc;
  });
  resolveRouteRoot = vi.fn(() => "D:/worktrees/t1/r1");
});

function makeSearch() {
  return createCodeSearch({ resolveRouteRoot, spawn: spawnFn });
}

describe("codeSearch rg invocation", () => {
  it("searches and opens only files in the active route", async () => {
    const search = makeSearch();
    const pending = search.search({ taskId: "t1", routeId: "r1", query: "needle" });
    const proc = spawns[0];
    proc.emitStdout("src/a.ts:12:5:const needle = 1;\n");
    proc.emitClose(0);
    await expect(pending).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "src/a.ts" })]),
    );
  });

  it("spawns rg with an argument array and no shell, scoped to the route root", async () => {
    const search = makeSearch();
    const pending = search.search({ taskId: "t1", routeId: "r1", query: "needle" });
    spawns[0].emitClose(1); // no matches
    await pending;
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [file, args, options] = spawnFn.mock.calls[0];
    expect(file).toBe("rg");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("--");
    expect(args[args.length - 1]).toBe("needle");
    expect(options.cwd).toBe("D:/worktrees/t1/r1");
    expect(options.shell).toBe(false);
    expect(resolveRouteRoot).toHaveBeenCalledWith("t1", "r1");
  });

  it("rejects an unknown task/route and an empty query before spawning", async () => {
    const search = createCodeSearch({
      resolveRouteRoot: vi.fn(() => undefined),
      spawn: spawnFn,
    });
    await expect(search.search({ taskId: "t1", routeId: "r9", query: "x" })).rejects.toThrow(
      "unknown task/route",
    );
    await expect(makeSearch().search({ taskId: "t1", routeId: "r1", query: "  " })).rejects.toThrow("query");
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("degrades to a clear error when rg is not on PATH (no fallback)", async () => {
    const search = makeSearch();
    const pending = search.search({ taskId: "t1", routeId: "r1", query: "needle" });
    spawns[0].emitError(Object.assign(new Error("spawn rg ENOENT"), { code: "ENOENT" }));
    await expect(pending).rejects.toThrow(/rg .*not available/i);
  });

  it("caps results at 200 matches", async () => {
    const search = makeSearch();
    const pending = search.search({ taskId: "t1", routeId: "r1", query: "needle" });
    const proc = spawns[0];
    const lines: string[] = [];
    for (let i = 1; i <= 500; i += 1) lines.push(`src/f${i}.ts:${i}:1:needle`);
    proc.emitStdout(lines.join("\n") + "\n");
    proc.emitClose(0);
    const matches = await pending;
    expect(matches).toHaveLength(200);
  });

  it("kills rg once the output cap is exceeded", async () => {
    const search = makeSearch();
    const pending = search.search({ taskId: "t1", routeId: "r1", query: "needle" });
    const proc = spawns[0];
    let guard = 0;
    while (!proc.killed && guard < 200) {
      proc.emitStdout(`${"x".repeat(64 * 1024)}\n`);
      guard += 1;
    }
    proc.emitClose(null);
    await pending;
    expect(proc.killed).toBe(true);
  });

  it("parses path/line/column/preview from vimgrep output", async () => {
    const search = makeSearch();
    const pending = search.search({ taskId: "t1", routeId: "r1", query: "needle" });
    spawns[0].emitStdout("src/deep/dir/b.ts:3:7:  const needle: number = 2;\n");
    spawns[0].emitClose(0);
    const matches = await pending;
    expect(matches).toEqual([
      { path: "src/deep/dir/b.ts", line: 3, column: 7, preview: "  const needle: number = 2;" },
    ]);
  });
});
