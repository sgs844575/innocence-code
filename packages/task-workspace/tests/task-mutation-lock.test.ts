import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import url from "node:url";
import { openSecureStorage, type SecureStorage } from "@innocencecode/secure-storage-node";
import { createTaskMutationLock, type TaskMutationLock } from "../src/task-mutation-lock.ts";
import { sha256Hex, type LockHandle } from "../src/workspace-lock.ts";

const execFileAsync = promisify(execFile);
const here = path.dirname(url.fileURLToPath(import.meta.url));

let base: string;
let storage: SecureStorage;
let lock: TaskMutationLock;

const TASK_ID = "task_lease_1";
const OWNER = { taskId: TASK_ID, routeId: "route_main" };
const OTHER = { taskId: TASK_ID, routeId: "route_fork" };

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-tws-tasklock-"));
  storage = await openSecureStorage(base, { dirs: ["locks", "locks/workspace", "locks/task"] });
  lock = createTaskMutationLock(storage);
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function spawnChild() {
  const child = spawn(process.execPath, [path.join(here, "task-mutation-lock.child.ts"), base], {
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
    async waitForEvent(event: string, timeoutMs = 10000): Promise<Record<string, unknown>> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        for (let index = 0; index < events.length; index += 1) {
          const queued = events[index]!;
          if (queued.event === event) {
            events.splice(0, index + 1);
            return queued;
          }
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for "${event}" from child ${child.pid}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    async noEventFor(ms: number): Promise<boolean> {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return events.length === 0;
    },
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

describe("task mutation lease (in-process semantics)", () => {
  it("uses locks/task/<sha256(taskId)>.lock with the shared lease format", async () => {
    const handle = (await lock.acquire(TASK_ID, OWNER)) as LockHandle;
    try {
      const expected = path.join(base, "locks", "task", `${sha256Hex(TASK_ID)}.lock`);
      expect(handle.lockPath).toBe(expected);
      const lease = JSON.parse(await fs.readFile(expected, "utf8")) as Record<string, unknown>;
      expect(lease.pid).toBe(process.pid);
      expect(lease.taskId).toBe(TASK_ID);
      expect(typeof lease.processStartId).toBe("string");
      expect(typeof lease.leaseToken).toBe("string");
    } finally {
      await handle.release();
    }
    await expect(fs.stat(path.join(base, "locks", "task", `${sha256Hex(TASK_ID)}.lock`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 30000);

  it("different taskIds map to independent leases", async () => {
    const first = (await lock.acquire("task_a", OWNER)) as LockHandle;
    const second = (await lock.acquire("task_b", OTHER)) as LockHandle;
    await first.release();
    await second.release();
  }, 30000);

  it("never steals from an active owner (abort on signal)", async () => {
    const handle = (await lock.acquire(TASK_ID, OWNER)) as LockHandle;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await expect(lock.acquire(TASK_ID, OTHER, controller.signal)).rejects.toThrowError(/abort/i);
    expect(await fs.stat(handle.lockPath)).toBeTruthy();
    await handle.release();
  }, 30000);
});

describe("task mutation lease (real child processes)", () => {
  it("serializes mutations: one winner, handover after release", async () => {
    const a = spawnChild();
    const b = spawnChild();
    try {
      expect((await a.nextEvent()).event).toBe("ready");
      expect((await b.nextEvent()).event).toBe("ready");

      a.send({ cmd: "acquire", taskId: TASK_ID, ownerTaskId: OWNER.taskId, routeId: OWNER.routeId });
      b.send({ cmd: "acquire", taskId: TASK_ID, ownerTaskId: OTHER.taskId, routeId: OTHER.routeId });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const acquired = [a, b].flatMap((proc) => proc.events.filter((event) => event.event === "acquired"));
      expect(acquired).toHaveLength(1);

      const winner = a.events.some((event) => event.event === "acquired") ? a : b;
      const loser = winner === a ? b : a;
      expect(await loser.noEventFor(400)).toBe(true);

      winner.send({ cmd: "release" });
      await winner.waitForEvent("released");
      await loser.waitForEvent("acquired");
      loser.send({ cmd: "release" });
      await loser.waitForEvent("released");
    } finally {
      await a.endGracefully();
      await b.endGracefully();
    }
  }, 30000);

  it("recovers the lease after the owning process is killed (taskkill /T /F)", async () => {
    const ownerChild = spawnChild();
    try {
      await ownerChild.nextEvent(); // ready
      ownerChild.send({ cmd: "acquire", taskId: TASK_ID, ownerTaskId: OWNER.taskId, routeId: OWNER.routeId });
      const acquired = await ownerChild.nextEvent();
      expect(acquired.event).toBe("acquired");

      await ownerChild.killTree();
      expect(await ownerChild.exited).not.toBe(0);

      const handle = (await lock.acquire(TASK_ID, OWNER)) as LockHandle; // stale-dead-owner path
      expect(handle.lease.pid).toBe(process.pid);
      await handle.release();
    } finally {
      await ownerChild.killTree();
    }
  }, 30000);
});
