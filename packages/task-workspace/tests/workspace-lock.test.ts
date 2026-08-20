import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import url from "node:url";
import { openSecureStorage, type SecureStorage } from "@innocencecode/secure-storage-node";
import { createWorkspaceWriteLock, sha256Hex, type LockHandle, type WorkspaceWriteLock } from "../src/workspace-lock.ts";

const execFileAsync = promisify(execFile);
const here = path.dirname(url.fileURLToPath(import.meta.url));

let base: string;
let storage: SecureStorage;
let lock: WorkspaceWriteLock;

const OWNER = { taskId: "task_ws", routeId: "route_main" };
const OTHER = { taskId: "task_other", routeId: "route_fork" };

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-tws-wslock-"));
  storage = await openSecureStorage(base, { dirs: ["locks", "locks/workspace", "locks/task"] });
  lock = createWorkspaceWriteLock(storage);
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

/** Spawns a real TS child process (Node type-stripping) speaking the JSON-line protocol. */
function spawnChild(scriptName: string, args: string[]) {
  const child = spawn(process.execPath, [path.join(here, scriptName), ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: Array<Record<string, unknown>> = [];
  let stderr = "";
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) {
        break;
      }
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          events.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // non-JSON child chatter is ignored
        }
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  return {
    pid: child.pid!,
    events,
    exited,
    send(command: Record<string, unknown>): void {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    },
    async nextEvent(timeoutMs = 10000): Promise<Record<string, unknown>> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const next = events.shift();
        if (next !== undefined) {
          return next;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for child event; stderr so far: ${stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    async noEventFor(ms: number): Promise<boolean> {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return events.length === 0;
    },
    /** Kills the whole process tree; child.kill() does not kill children on Windows. */
    async killTree(): Promise<void> {
      if (child.exitCode !== null) {
        return;
      }
      if (process.platform === "win32") {
        await execFileAsync("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
      } else {
        child.kill("SIGKILL");
      }
      await exited;
    },
    async endGracefully(): Promise<void> {
      this.send({ cmd: "exit" });
      await exited;
    },
  };
}

type LockChild = ReturnType<typeof spawnChild>;

/** Consumes queued child events until one with `event` arrives. */
async function waitForEvent(child: LockChild, event: string, timeoutMs = 10000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let index = 0; index < child.events.length; index += 1) {
      const queued = child.events[index]!;
      if (queued.event === event) {
        child.events.splice(0, index + 1);
        return queued;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for "${event}" from child ${child.pid}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const acquireCmd = { cmd: "acquire", ...OWNER };

describe("workspace write lock (in-process semantics)", () => {
  it("creates the lease at locks/workspace/<sha256(realpath)>.lock and removes it on release", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(base, "ws-"));
    const handle = (await lock.acquire(workspaceRoot, OWNER)) as LockHandle;
    const expected = path.join(base, "locks", "workspace", `${sha256Hex(await fs.realpath(workspaceRoot))}.lock`);
    expect(handle.lockPath).toBe(expected);
    const lease = JSON.parse(await fs.readFile(expected, "utf8")) as Record<string, unknown>;
    expect(lease.pid).toBe(process.pid);
    expect(lease.taskId).toBe(OWNER.taskId);
    expect(lease.routeId).toBe(OWNER.routeId);
    expect(typeof lease.leaseToken).toBe("string");
    await handle.release();
    await expect(fs.stat(expected)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30000);

  it("never steals from an active owner: a second acquire aborts on its signal", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(base, "ws-"));
    const handle = (await lock.acquire(workspaceRoot, OWNER)) as LockHandle;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await expect(lock.acquire(workspaceRoot, OTHER, controller.signal)).rejects.toThrowError(/abort/i);
    // the owner still holds its lease file
    expect(await fs.stat(handle.lockPath)).toBeTruthy();
    await handle.release();
  }, 30000);

  it("release is idempotent and a released lock can be re-acquired", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(base, "ws-"));
    const first = (await lock.acquire(workspaceRoot, OWNER)) as LockHandle;
    await first.release();
    await first.release();
    const second = (await lock.acquire(workspaceRoot, OTHER)) as LockHandle;
    await second.release();
  }, 30000);

  it("never recovers an unparseable lease (a live but stalled owner keeps its lock)", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(base, "ws-"));
    // Simulate a writer that created the lock file but stalled before its
    // content flushed (or any foreign/corrupt lease): no PID is provable, so
    // recovery is forbidden — the contender must wait, never delete.
    const lockPath = path.join(base, "locks", "workspace", `${sha256Hex(await fs.realpath(workspaceRoot))}.lock`);
    await fs.writeFile(lockPath, "");

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    await expect(lock.acquire(workspaceRoot, OWNER, controller.signal)).rejects.toThrowError(/abort/i);
    expect(await fs.readFile(lockPath, "utf8")).toBe(""); // untouched

    // same for readable-but-garbage content
    await fs.writeFile(lockPath, "not-a-lease");
    const secondController = new AbortController();
    setTimeout(() => secondController.abort(), 400);
    await expect(lock.acquire(workspaceRoot, OWNER, secondController.signal)).rejects.toThrowError(/abort/i);
    expect(await fs.readFile(lockPath, "utf8")).toBe("not-a-lease");
  }, 30000);

  it("never treats a non-ENOENT read error as a released lock", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(base, "ws-"));
    // A directory at the lease path makes reads fail with EISDIR (not
    // ENOENT): transient/systemic read failures must never become "stale".
    const lockPath = path.join(base, "locks", "workspace", `${sha256Hex(await fs.realpath(workspaceRoot))}.lock`);
    await fs.mkdir(lockPath);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    await expect(lock.acquire(workspaceRoot, OWNER, controller.signal)).rejects.toThrowError(/abort/i);
    expect((await fs.stat(lockPath)).isDirectory()).toBe(true); // untouched
  }, 30000);
});

describe("workspace write lock (real child processes)", () => {
  it("yields exactly one winner when two processes compete, then hands over after release", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(base, "ws-"));
    const a = spawnChild("workspace-lock.child.ts", [base, workspaceRoot]);
    const b = spawnChild("workspace-lock.child.ts", [base, workspaceRoot]);
    try {
      expect((await a.nextEvent()).event).toBe("ready");
      expect((await b.nextEvent()).event).toBe("ready");

      // both race for the lock at (roughly) the same moment
      a.send({ ...acquireCmd, workspaceKey: workspaceRoot });
      b.send({ ...acquireCmd, workspaceKey: workspaceRoot });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const acquired = [a, b].flatMap((proc) => proc.events.filter((event) => event.event === "acquired"));
      expect(acquired).toHaveLength(1);

      const winner = a.events.some((event) => event.event === "acquired") ? a : b;
      const loser = winner === a ? b : a;
      // the loser is still blocked while the winner holds the lease
      expect(await loser.noEventFor(500)).toBe(true);

      winner.send({ cmd: "release" });
      expect((await waitForEvent(winner, "released")).event).toBe("released");
      // the loser acquires as soon as the lease frees
      expect((await waitForEvent(loser, "acquired")).event).toBe("acquired");
      loser.send({ cmd: "release" });
      expect((await waitForEvent(loser, "released")).event).toBe("released");
    } finally {
      await a.endGracefully();
      await b.endGracefully();
    }
  }, 30000);

  it("an active owner's lease is NOT recoverable by a contender process", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(base, "ws-"));
    const ownerChild = spawnChild("workspace-lock.child.ts", [base, workspaceRoot]);
    const contenderChild = spawnChild("workspace-lock.child.ts", [base, workspaceRoot]);
    try {
      await ownerChild.nextEvent(); // ready
      await contenderChild.nextEvent(); // ready
      ownerChild.send({ ...acquireCmd, workspaceKey: workspaceRoot });
      expect((await ownerChild.nextEvent()).event).toBe("acquired");

      contenderChild.send({ ...acquireCmd, workspaceKey: workspaceRoot });
      // the contender keeps retrying and NEVER wins while the owner lives
      expect(await contenderChild.noEventFor(1200)).toBe(true);

      // only the real release hands the lease over: the contender (the only
      // remaining acquirer) must acquire afterwards — the owner's lease was
      // never stolen while it was alive
      ownerChild.send({ cmd: "release" });
      expect((await waitForEvent(ownerChild, "released")).event).toBe("released");
      expect((await waitForEvent(contenderChild, "acquired")).event).toBe("acquired");
      contenderChild.send({ cmd: "release" });
      await waitForEvent(contenderChild, "released");

      // the lock file is healthy after the handover: a fresh acquire works
      ownerChild.send({ ...acquireCmd, workspaceKey: workspaceRoot });
      expect((await waitForEvent(ownerChild, "acquired")).event).toBe("acquired");
      ownerChild.send({ cmd: "release" });
      await waitForEvent(ownerChild, "released");
    } finally {
      await ownerChild.endGracefully();
      await contenderChild.endGracefully();
    }
  }, 30000);

  it("recovers the lease after the owner process is killed (taskkill /T /F)", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(base, "ws-"));
    const ownerChild = spawnChild("workspace-lock.child.ts", [base, workspaceRoot]);
    try {
      await ownerChild.nextEvent(); // ready
      ownerChild.send({ ...acquireCmd, workspaceKey: workspaceRoot });
      const acquired = await ownerChild.nextEvent();
      expect(acquired.event).toBe("acquired");
      const deadPid = acquired.pid;

      await ownerChild.killTree();
      expect(await ownerChild.exited).not.toBe(0);

      // fresh acquire takes the stale-dead-owner path and wins
      const handle = (await lock.acquire(workspaceRoot, OWNER)) as LockHandle;
      expect(handle.lease.pid).toBe(process.pid);
      expect(handle.lease.pid).not.toBe(deadPid);
      await handle.release();
    } finally {
      await ownerChild.killTree();
    }
  }, 30000);

  it("repeated simultaneous races always yield exactly one winner (atomic lease publish)", async () => {
    // Regression for the create-vs-flush race: with link()-based publishing
    // a lock file only ever appears with its full lease content, so a
    // contender can never misread a live owner's lock as empty/stale.
    for (let round = 0; round < 3; round += 1) {
      const workspaceRoot = await fs.mkdtemp(path.join(base, `race-${round}-`));
      const a = spawnChild("workspace-lock.child.ts", [base, workspaceRoot]);
      const b = spawnChild("workspace-lock.child.ts", [base, workspaceRoot]);
      try {
        expect((await a.nextEvent()).event).toBe("ready");
        expect((await b.nextEvent()).event).toBe("ready");
        a.send({ ...acquireCmd, workspaceKey: workspaceRoot });
        b.send({ ...acquireCmd, workspaceKey: workspaceRoot });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const acquired = [a, b].flatMap((proc) => proc.events.filter((event) => event.event === "acquired"));
        expect(acquired, `round ${round}`).toHaveLength(1);

        const winner = a.events.some((event) => event.event === "acquired") ? a : b;
        const loser = winner === a ? b : a;
        winner.send({ cmd: "release" });
        await waitForEvent(winner, "released");
        await waitForEvent(loser, "acquired");
        loser.send({ cmd: "release" });
        await waitForEvent(loser, "released");
      } finally {
        await a.endGracefully();
        await b.endGracefully();
      }
    }
  }, 30000);
});
