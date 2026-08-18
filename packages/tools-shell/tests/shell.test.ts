import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bashTool, runCommand } from "../src";
import type { ToolContext } from "@innocencecode/harness-core";

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-shell-"));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({
  workspaceRoot: root,
  signal: new AbortController().signal,
  log: () => {},
});

describe("runCommand", () => {
  it("captures stdout, stderr and exit code", async () => {
    const isWin = process.platform === "win32";
    const r = await runCommand({
      command: isWin ? "echo hello & echo err 1>&2" : "echo hello; echo err >&2",
      cwd: root,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
    expect(r.stderr).toContain("err");
  });

  it("reports non-zero exit codes", async () => {
    const r = await runCommand({
      command: process.platform === "win32" ? "exit /b 3" : "exit 3",
      cwd: root,
    });
    expect(r.exitCode).toBe(3);
  });

  it("times out long-running commands", async () => {
    const isWin = process.platform === "win32";
    const r = await runCommand({
      command: isWin ? "ping -n 30 127.0.0.1" : "sleep 30",
      cwd: root,
      timeoutMs: 1000,
    });
    expect(r.timedOut).toBe(true);
  }, 15000);

  it("truncates oversized output", async () => {
    const isWin = process.platform === "win32";
    const r = await runCommand({
      command: isWin ? "for /L %i in (1,1,5000) do @echo 0123456789012345678901234567890123456789"
        : "for i in $(seq 1 5000); do echo 0123456789012345678901234567890123456789; done",
      cwd: root,
      maxOutputChars: 2000,
    });
    expect(r.stdout.length).toBeLessThanOrEqual(2100);
    expect(r.stdout).toContain("已截断");
  });
});

describe("bashTool", () => {
  it("marks non-zero exits as error results with stderr attached", async () => {
    const isWin = process.platform === "win32";
    const r = await bashTool.execute(
      { command: isWin ? "echo boom 1>&2 & exit /b 1" : "echo boom >&2; exit 1" },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("boom");
    expect(r.content).toContain("stderr");
  });

  it("runs in the workspace root", async () => {
    const isWin = process.platform === "win32";
    const r = await bashTool.execute({ command: isWin ? "cd" : "pwd" }, ctx());
    expect(r.isError).toBeFalsy();
    const normalized = r.content.replace(/\\/g, "/").toLowerCase();
    expect(normalized).toContain(root.replace(/\\/g, "/").toLowerCase());
  });

  it("rejects missing command arg", async () => {
    await expect(bashTool.execute({}, ctx())).rejects.toThrow("command");
  });
});
