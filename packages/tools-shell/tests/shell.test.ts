import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Context } from "@innocencecode/kernel";
import { ToolsPlugin } from "@innocencecode/harness-tools";
import { ShellPlugin, bashTool, runCommand } from "../src";
import {
  createExecutionScope,
  parseRuleSpec,
  PermissionEngine,
  redactCommand,
  redactCommandSummary,
  sha256Hex,
  type PermissionRequest,
  type ToolContext,
} from "@innocencecode/harness-core";

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
  scope: createExecutionScope("Bash"),
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

describe("ShellPlugin", () => {
  it("registers Bash with the coarse process side-effect class", async () => {
    const ctx = new Context();
    await ctx.plugin(ToolsPlugin);
    await ctx.plugin(ShellPlugin);
    expect(ctx.tools.get("Bash")).toMatchObject({ sideEffect: "process" });
  });
});

describe("bashTool persistence policy", () => {
  const SECRET = "SHELL-SECRET-8e17c3";

  it("persists program word plus shape-legal subcommands, never values or secrets", () => {
    const command = "npm test -- -u";
    expect(bashTool.persistArgs({ command })).toEqual({
      command: "npm test",
      commandSha256: sha256Hex(command),
    });
    expect(bashTool.persistArgs({ command: "npm run build" }).command).toBe("npm run build");
    // Flags, assignments, values and secrets stop the token walk immediately.
    expect(bashTool.persistArgs({ command: `deploy --token=${SECRET}` }).command).toBe("deploy");
    expect(bashTool.persistArgs({ command: `send ${SECRET}` }).command).toBe("send");
    expect(JSON.stringify(bashTool.persistArgs({ command: `curl -H "Authorization: Bearer ${SECRET}" https://x/y` })))
      .not.toContain(SECRET);
  });

  it("resource scope carries the same subcommand granularity as the persisted summary", async () => {
    const resource = await bashTool.permissionResource({ command: "npm test" }, ctx());
    expect(resource).toEqual({ action: "execute", kind: "command", scope: "npm test" });
    expect((await bashTool.permissionResource({ command: "npm publish" }, ctx())).scope).toBe(
      "npm publish",
    );
    // Flags/values never enter the scope (same shape-checked walk as the summary).
    expect((await bashTool.permissionResource({ command: `deploy --token=${SECRET}` }, ctx())).scope).toBe(
      "deploy",
    );
  });

  it("npm test session grant does not admit npm publish (end-to-end through the real tool)", async () => {
    const engine = new PermissionEngine({
      mode: "ask",
      decider: { ask: async () => "allowSession" },
    });
    const request = async (raw: string): Promise<PermissionRequest> => ({
      toolName: "Bash",
      resource: await bashTool.permissionResource({ command: raw }, ctx()),
      args: bashTool.persistArgs({ command: raw }),
    });
    const meta = { readOnly: false, sideEffect: "process" as const };

    const first = await engine.resolve(await request("npm test"), meta);
    expect(first.via).toBe("ask"); // ask once, user allows for the session

    // Different subcommand under the same program: different scope -> must ask again.
    const second = await engine.resolve(await request("npm publish"), meta);
    expect(second.via).toBe("ask");
    expect(second.via).not.toBe("sessionGrant");

    // Same canonical summary (flags dropped) reuses the grant without asking.
    const third = await engine.resolve(await request("npm test -- -u"), meta);
    expect(third.via).toBe("sessionGrant");
  });

  it("project allow rules revive against the persisted summary", () => {
    const allow = parseRuleSpec("Bash(npm test)", "allow");
    const match = (raw: string) =>
      allow.match({ toolName: "Bash", args: bashTool.persistArgs({ command: raw }) });
    expect(match("npm test")).toBe("allow");
    expect(match("npm test -- -u")).toBe("allow"); // flags dropped from the summary
    expect(match("npm install")).toBe("skip");
    expect(match("npm publish")).toBe("skip");
  });

  it("project deny rules revive against the persisted summary", () => {
    const deny = parseRuleSpec("Bash(curl evil.com)", "deny");
    const match = (raw: string) =>
      deny.match({ toolName: "Bash", args: bashTool.persistArgs({ command: raw }) });
    expect(match("curl evil.com -X POST")).toBe("deny");
    expect(match("curl docs.example.com")).toBe("skip");
    expect(match("echo hi")).toBe("skip");
  });

  it("validateArgs rejects a missing command before anything else runs", async () => {
    await expect(bashTool.validateArgs?.({})).rejects.toThrow("command");
    await expect(bashTool.validateArgs?.({ command: "   " })).rejects.toThrow("command");
  });

  it("redactCommand masks non-command-shaped program words", () => {
    expect(redactCommand(`${SECRET} run`)).toBe("[redacted]");
  });

  it("redactCommandSummary keeps only shape-legal leading tokens", () => {
    expect(redactCommandSummary("npm test -- -u")).toBe("npm test");
    expect(redactCommandSummary("git")).toBe("git");
    expect(redactCommandSummary("--flag first")).toBe("[redacted]");
    expect(redactCommandSummary(`node ./run.js ${SECRET}`)).toBe("node");
  });
});
