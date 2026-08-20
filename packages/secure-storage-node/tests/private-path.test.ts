import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  SECURE_SUBDIRS,
  isSafeRelativePath,
  openSecureStorage,
  type ExecRunner,
} from "../src/private-path.ts";

const exec = promisify(execFile);

let base: string;

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-secstore-"));
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const uniqueRoot = () => path.join(base, `root-${Math.random().toString(36).slice(2)}`);

describe("secure storage paths", () => {
  it("creates the root and every canonical subpath under the given base dir", async () => {
    const storage = await openSecureStorage(uniqueRoot());
    for (const dir of SECURE_SUBDIRS) {
      const stat = await fs.stat(path.join(storage.root, ...dir.split("/")));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it("creates only the requested dirs when dirs is provided", async () => {
    const storage = await openSecureStorage(uniqueRoot(), { dirs: ["locks", "locks/task"] });
    expect((await fs.stat(path.join(storage.root, "locks", "task"))).isDirectory()).toBe(true);
    await expect(fs.stat(path.join(storage.root, "objects"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolve() rejects escapes, absolute paths and backslashes", async () => {
    const storage = await openSecureStorage(uniqueRoot(), { dirs: [] });
    expect(() => storage.resolve("../escape")).toThrow();
    expect(() => storage.resolve("a/../../escape")).toThrow();
    expect(() => storage.resolve("/abs")).toThrow();
    expect(() => storage.resolve("C:/abs")).toThrow();
    expect(() => storage.resolve("a\\b")).toThrow();
    expect(() => storage.resolve("")).toThrow();
    expect(storage.resolve("locks/task")).toBe(path.join(storage.root, "locks", "task"));
  });

  it("isSafeRelativePath accepts normal relative paths only", () => {
    expect(isSafeRelativePath("a.txt")).toBe(true);
    expect(isSafeRelativePath("a/b/c.txt")).toBe(true);
    expect(isSafeRelativePath("..")).toBe(false);
    expect(isSafeRelativePath(".")).toBe(false);
    expect(isSafeRelativePath("a//b")).toBe(false);
    expect(isSafeRelativePath("")).toBe(false);
  });

  it("ensureDir creates nested secured directories and is idempotent", async () => {
    const storage = await openSecureStorage(uniqueRoot(), { dirs: [] });
    const first = await storage.ensureDir("journal/2026/08");
    const second = await storage.ensureDir("journal/2026/08");
    expect(first).toBe(second);
    expect((await fs.stat(first)).isDirectory()).toBe(true);
  });
});

describe("secure storage file primitives", () => {
  it("writes, reads, appends and deletes files through validated paths", async () => {
    const storage = await openSecureStorage(uniqueRoot(), { dirs: ["objects"] });
    await storage.writeFile("objects/a.txt", "hello");
    expect(await storage.readTextFile("objects/a.txt")).toBe("hello");
    await storage.appendFile("objects/a.txt", "-world");
    expect(await storage.readTextFile("objects/a.txt")).toBe("hello-world");
    expect(Array.from(await storage.readFile("objects/a.txt"))).toEqual(
      Array.from(new TextEncoder().encode("hello-world")),
    );
    await storage.deleteFile("objects/a.txt");
    expect(await storage.fileExists("objects/a.txt")).toBe(false);
    // deleting a missing file is not an error
    await storage.deleteFile("objects/a.txt");
  });

  it("createFileExclusive is atomic: only the first creator wins", async () => {
    const storage = await openSecureStorage(uniqueRoot(), { dirs: ["locks"] });
    const first = await storage.createFileExclusive("locks/a.lock", "owner-1");
    const second = await storage.createFileExclusive("locks/a.lock", "owner-2");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await storage.readTextFile("locks/a.lock")).toBe("owner-1");
  });

  it("createFileExclusive publishes complete content atomically (link, never an empty file)", async () => {
    const storage = await openSecureStorage(uniqueRoot(), { dirs: ["locks"] });
    const lease = JSON.stringify({ pid: process.pid, token: "abc" });
    const result = await storage.createFileExclusive("locks/ws.lock", lease);
    // The target exists WITH its full content the moment it exists at all —
    // no contender can ever read an empty or partial lease.
    expect(result.created).toBe(true);
    expect(await fs.readFile(result.path, "utf8")).toBe(lease);
    // loser keeps the winner's bytes untouched
    const loser = await storage.createFileExclusive("locks/ws.lock", "other");
    expect(loser.created).toBe(false);
    expect(await fs.readFile(loser.path, "utf8")).toBe(lease);
    // no temp siblings are left behind after success or after EEXIST
    const siblings = (await fs.readdir(path.join(storage.root, "locks"))).filter((name) => name.endsWith(".tmp"));
    expect(siblings).toEqual([]);
  });

  it("writeFileAtomic replaces content and leaves no temp files behind", async () => {
    const storage = await openSecureStorage(uniqueRoot(), { dirs: ["checkpoints"] });
    await storage.writeFileAtomic("checkpoints/cp.json", "v1");
    await storage.writeFileAtomic("checkpoints/cp.json", "v2");
    expect(await storage.readTextFile("checkpoints/cp.json")).toBe("v2");
    const temps = (await fs.readdir(path.join(storage.root, "temp"))).filter((name) => name.endsWith(".tmp"));
    expect(temps).toEqual([]);
  });

  it("createTempDir returns a unique directory under temp", async () => {
    const storage = await openSecureStorage(uniqueRoot(), { dirs: [] });
    const a = await storage.createTempDir("tx");
    const b = await storage.createTempDir("tx");
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.join(storage.root, "temp"));
    expect((await fs.stat(a)).isDirectory()).toBe(true);
  });

  it("listDir reads entries of a subdir and the root", async () => {
    const storage = await openSecureStorage(uniqueRoot(), { dirs: ["objects"] });
    await storage.writeFile("objects/k1", "x");
    expect(await storage.listDir("objects")).toEqual(["k1"]);
    expect(await storage.listDir()).toEqual(["objects"]);
  });
});

describe("platform hardening branches", () => {
  it("win32 branch runs icacls with inheritance removal and a current-user-only grant", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const fakeExec: ExecRunner = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    };
    const storage = await openSecureStorage(uniqueRoot(), {
      dirs: [],
      platform: "win32",
      execFile: fakeExec,
      windowsSid: "S-1-5-21-test",
    });
    await storage.ensureDir("extra");
    const icaclsCalls = calls.filter((call) => call.file === "icacls");
    expect(icaclsCalls.length).toBeGreaterThan(0);
    for (const call of icaclsCalls) {
      expect(call.args).toContain("/inheritance:r");
      expect(call.args.some((arg) => arg.startsWith("*S-1-5-21-test:(OI)(CI)(F)"))).toBe(true);
    }
    // whoami must not run when the SID was injected
    expect(calls.some((call) => call.file === "whoami")).toBe(false);
  });

  it("posix branch never shells out and keeps modes where the OS supports them", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const fakeExec: ExecRunner = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    };
    const storage = await openSecureStorage(uniqueRoot(), {
      dirs: ["objects"],
      platform: "linux",
      execFile: fakeExec,
    });
    await storage.writeFile("objects/f.txt", "data");
    expect(calls).toEqual([]); // no ACL tooling on the POSIX branch
    if (process.platform !== "win32") {
      const dirStat = await fs.stat(path.join(storage.root, "objects"));
      expect(dirStat.mode & 0o777).toBe(0o700);
      const fileStat = await fs.stat(path.join(storage.root, "objects", "f.txt"));
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
  });
});

describe.runIf(process.platform === "win32")("real Windows ACL hardening", () => {
  it("restricts the storage root to the current user only", async () => {
    const root = uniqueRoot();
    const storage = await openSecureStorage(root, { dirs: ["objects"] });
    const [{ stdout: whoamiOut }, { stdout: aclOut }] = await Promise.all([
      exec("whoami"),
      exec("icacls", [root]),
    ]);
    const currentUser = whoamiOut.trim().toLowerCase();
    expect(aclOut.toLowerCase()).toContain(currentUser);
    expect(aclOut.toLowerCase()).not.toContain("everyone");
    expect(aclOut.toLowerCase()).not.toContain("builtin\\");
    // newly created subdirs inherit the same restricted ACL
    const child = await exec("icacls", [path.join(storage.root, "objects")]);
    expect(child.stdout.toLowerCase()).not.toContain("everyone");
  });
});
