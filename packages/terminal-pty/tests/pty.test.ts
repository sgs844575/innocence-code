// Real node-pty tests for the route-bound PTY manager. These spawn REAL
// shells on this machine (cmd.exe on win32) — no fakes. Covers:
//   1. cwd is the route workspace (brief-verbatim test)
//   2. output/exit events carry taskId/routeId/ptyId
//   3. dispose kills the whole process tree (taskkill /T /F on win32)
//   4. disposeForRoute releases only that route's session
//   5. disposeAll releases everything
//   6. a shell that exits on its own is dropped from the registry
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPtyManager, type PtyEvent, type PtyManager } from "../src/index";

const execFileAsync = promisify(execFile);
const isWin = process.platform === "win32";

let fixtureRoot: string;
let manager: PtyManager;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "pty-cwd-"));
  manager = createPtyManager();
});

afterAll(async () => {
  await manager.disposeAll();
  await rm(fixtureRoot, { recursive: true, force: true });
});

/** tasklist-based liveness probe (win32); signal-0 probe elsewhere. */
async function pidAlive(pid: number): Promise<boolean> {
  if (isWin) {
    try {
      const { stdout } = await execFileAsync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { windowsHide: true },
      );
      return stdout.split("\n").some((line) => line.includes(`"${pid}"`));
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Retries the probe until it reports dead or the budget runs out. */
async function eventuallyDead(pid: number, budgetMs = 4000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!(await pidAlive(pid))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !(await pidAlive(pid));
}

describe("PtyManager (real node-pty)", () => {
  it(
    "starts with the route workspace as cwd",
    async () => {
      const pty = await manager.create({ taskId: "t1", routeId: "r1", cwd: fixtureRoot });
      await pty.write(process.platform === "win32" ? "cd\r" : "pwd\n");
      await expect(pty.output()).resolves.toContain(fixtureRoot);
    },
    20_000,
  );

  it(
    "emits output and exit events carrying taskId/routeId/ptyId",
    async () => {
      const events: PtyEvent[] = [];
      const scoped = createPtyManager({ onEvent: (event) => events.push(event) });
      const pty = await scoped.create({ taskId: "t-ev", routeId: "r-ev", cwd: fixtureRoot });
      await pty.write(isWin ? "cd\r" : "pwd\n");
      await pty.output();
      await pty.dispose();
      const output = events.find((e) => e.type === "output");
      const exit = events.find((e) => e.type === "exit");
      expect(output).toMatchObject({ taskId: "t-ev", routeId: "r-ev", ptyId: pty.ptyId });
      expect(exit).toMatchObject({ taskId: "t-ev", routeId: "r-ev", ptyId: pty.ptyId });
      await scoped.disposeAll();
    },
    20_000,
  );

  it(
    "dispose kills the whole shell process tree — no survivors",
    async () => {
      const pty = await manager.create({ taskId: "t-tree", routeId: "r-tree", cwd: fixtureRoot });
      // Start a child process FROM the shell; it prints its own pid and idles.
      await pty.write(
        isWin
          ? `node -e "console.log('MAGIC'+process.pid); setInterval(()=>{},1000000)"\r`
          : `node -e 'console.log("MAGIC"+process.pid); setInterval(()=>{},1000000)'\n`,
      );
      const text = await pty.output();
      const match = text.match(/MAGIC(\d+)/);
      expect(match).not.toBeNull();
      const childPid = Number(match![1]);
      expect(await pidAlive(childPid)).toBe(true);

      await pty.dispose();
      expect(await eventuallyDead(childPid)).toBe(true);
      expect(manager.get("t-tree", "r-tree")).toBeUndefined();
    },
    40_000,
  );

  it(
    "disposeForRoute releases only that route's session",
    async () => {
      await manager.create({ taskId: "t-multi", routeId: "ra", cwd: fixtureRoot });
      const keep = await manager.create({ taskId: "t-multi", routeId: "rb", cwd: fixtureRoot });
      await manager.disposeForRoute("t-multi", "ra");
      expect(manager.get("t-multi", "ra")).toBeUndefined();
      expect(manager.get("t-multi", "rb")).toBeDefined();
      // The surviving session still works.
      await keep.write(isWin ? "cd\r" : "pwd\n");
      await expect(keep.output()).resolves.toContain(fixtureRoot);
      await manager.disposeForRoute("t-multi", "rb");
    },
    20_000,
  );

  it(
    "disposeAll releases every session",
    async () => {
      const scoped = createPtyManager();
      const a = await scoped.create({ taskId: "t-all", routeId: "r1", cwd: fixtureRoot });
      const b = await scoped.create({ taskId: "t-all", routeId: "r2", cwd: fixtureRoot });
      await scoped.disposeAll();
      expect(scoped.get("t-all", "r1")).toBeUndefined();
      expect(scoped.get("t-all", "r2")).toBeUndefined();
      // dispose() resolving proves each shell's exit event was observed.
      await expect(a.dispose()).resolves.toBeUndefined();
      await expect(b.dispose()).resolves.toBeUndefined();
    },
    20_000,
  );

  it(
    "drops the session after the shell exits on its own (no dangling entries)",
    async () => {
      const pty = await manager.create({ taskId: "t-self", routeId: "r-self", cwd: fixtureRoot });
      const exited = new Promise<void>((resolve) => {
        pty.onExit(() => resolve());
      });
      await pty.write(isWin ? "exit\r" : "exit\n");
      await exited;
      expect(manager.get("t-self", "r-self")).toBeUndefined();
    },
    20_000,
  );
});
