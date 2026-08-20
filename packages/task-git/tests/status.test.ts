/**
 * Task 3 step 3 + detect: safe git process invocations (allowlist, caps,
 * AbortSignal), workspace detection (git vs non-git), and porcelain v2
 * parsing.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  createGitAdapter,
  GitCommandRefusedError,
  GitProcessError,
  parsePorcelainV2,
  runGit,
} from "../src/index.ts";
import {
  createGitFixture,
  gitExec,
  tempDir,
  track,
  trackDir,
} from "./fixtures.ts";

const sha256 = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

describe("git process guard", () => {
  it("refuses forbidden git verbs", async () => {
    const cwd = await tempDir();
    const forbidden: string[][] = [
      ["add", "."],
      ["reset", "--hard"],
      ["checkout", "main"],
      ["stash"],
      ["stash", "push"],
      ["commit", "-m", "x"],
      ["push"],
      ["rm", "a.txt"],
      ["worktree", "add", "somewhere"], // missing --detach
      ["worktree", "remove", "somewhere"], // missing --force
      ["worktree", "lock", "somewhere"],
      ["hash-object", "-w", "a.txt"], // -w writes into the object database
      ["status", "--porcelain"], // wrong form: only porcelain=v2 -z --branch is allowed
      ["status", "--porcelain=v2", "-z"], // missing --branch
      ["rev-parse", "--git-dir"],
      ["ls-files", "-s", "--others"],
      ["diff"],
      ["config", "user.name", "evil"],
    ];
    for (const args of forbidden) {
      await expect(runGit("git", args, { cwd })).rejects.toBeInstanceOf(GitCommandRefusedError);
    }
  });

  it("allows the probe and worktree verbs", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "a\n" } }));
    const out = async (args: string[]): Promise<string> =>
      (await runGit("git", args, { cwd: fixture.root })).stdout.toString("utf8");
    await expect(runGit("git", ["rev-parse", "--show-toplevel"], { cwd: fixture.root })).resolves.toHaveProperty(
      "stdout",
      expect.any(Buffer),
    );
    expect((await out(["rev-parse", "HEAD"])).trim()).toMatch(/^[0-9a-f]{40}$/);
    expect((await out(["branch", "--show-current"])).trim()).toBe("main");
    expect(await out(["status", "--porcelain=v2", "-z", "--branch"])).toContain("# branch.head main");
    expect((await out(["ls-files", "-s"])).trim()).toContain("a.txt");
    expect(await out(["diff", "--cached"])).toBe("");
    expect((await out(["hash-object", "a.txt"])).trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("caps oversized stdout", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 24; index += 1) {
      files[`untracked-with-a-rather-long-name-${index}-padding-padding.txt`] = "x\n";
    }
    const fixture = track(await createGitFixture({ untracked: files }));
    await expect(
      runGit("git", ["status", "--porcelain=v2", "-z", "--branch"], {
        cwd: fixture.root,
        maxOutputBytes: 64,
      }),
    ).rejects.toThrow(/exceed|output/i);
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeGreaterThan(0);
  });

  it("honors an aborted signal", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "a\n" } }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      runGit("git", ["rev-parse", "HEAD"], { cwd: fixture.root, signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });

  it("surfaces git failures with a stripped stderr excerpt", async () => {
    const cwd = trackDir(await tempDir());
    const error = await runGit("git", ["rev-parse", "HEAD"], { cwd }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProcessError);
    expect((error as Error).message).toMatch(/not a git repository/i);
    const gitError = error as GitProcessError;
    expect(gitError.command).toContain("rev-parse");
    expect(gitError.stderr.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-control-regex
    expect(gitError.stderr).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  });
});

describe("detect", () => {
  it("returns git workspace info for a repository", async () => {
    const fixture = track(
      await createGitFixture({ committed: { "a.txt": "a\n" } }),
    );
    const info = await createGitAdapter().detect(fixture.root);
    expect(info.kind).toBe("git");
    expect(info.branch).toBe("main");
    expect(info.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(info.root.length).toBeGreaterThan(0);
  });

  it("detects the toplevel from a nested directory", async () => {
    const fixture = track(await createGitFixture({ committed: { "a.txt": "a\n" } }));
    const nested = trackDir(`${fixture.root}/nested/deeper`);
    await fs.mkdir(nested, { recursive: true });
    const info = await createGitAdapter().detect(nested);
    expect(info.kind).toBe("git");
    // same repository toplevel despite the nested cwd
    const toplevel = (await gitExec(fixture.root, ["rev-parse", "--show-toplevel"])).stdout.trim();
    expect(info.root.replace(/\\/g, "/").toLowerCase()).toBe(toplevel.toLowerCase());
  });

  it("rejects a non-Git directory with a typed error", async () => {
    const dir = trackDir(await tempDir());
    const adapter = createGitAdapter();
    const error = await adapter.detect(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/not a Git repository/i);
    expect((error as { code?: string }).code).toBe("NOT_A_GIT_REPOSITORY");
  });

  it("reports detached HEAD as branch null", async () => {
    const fixture = track(
      await createGitFixture({
        committed: { "a.txt": "a\n" },
        postSetup: async (root) => {
          await gitExec(root, ["checkout", "--detach", "HEAD"]);
        },
      }),
    );
    const info = await createGitAdapter().detect(fixture.root);
    expect(info.kind).toBe("git");
    expect(info.branch).toBeNull();
    expect(info.headCommit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("porcelain v2 parsing", () => {
  it("parses branch headers", () => {
    const output = [
      "# branch.oid 1234567890123456789012345678901234567890",
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +2 -1",
      "",
    ].join("\0");
    const parsed = parsePorcelainV2(output);
    expect(parsed.branch.head).toBe("feature/x");
    expect(parsed.branch.detached).toBe(false);
    expect(parsed.branch.oid).toBe("1234567890123456789012345678901234567890");
    expect(parsed.branch.upstream).toBe("origin/feature/x");
    expect(parsed.branch.ab).toBe("+2 -1");
    expect(parsed.entries).toEqual([]);
  });

  it("parses ordinary, renamed, unmerged and untracked records (NUL separated)", () => {
    const renamedRecord = "2 R. N... 100644 100644 100644 abcdef01 abcdef01 R100 new name.ts";
    const output = [
      "# branch.oid 1234567890123456789012345678901234567890",
      "# branch.head main",
      "1 M. N... 100644 100644 100644 aaaabbbb aaaabbbb staged only.txt",
      "1 .M N... 100644 100644 100644 ccccdddd ccccdddd dirty only.txt",
      renamedRecord,
      "old name.ts",
      "u UU N... 100644 100644 100644 100644 eeeeffff 0000aaaa bbbbcccc both modified.txt",
      "? untracked dir/",
      "? loose file.txt",
      "",
    ].join("\0");
    const parsed = parsePorcelainV2(output);
    expect(parsed.entries).toHaveLength(6);

    const staged = parsed.entries[0]!;
    expect(staged.kind).toBe("ordinary");
    expect(staged.xy).toBe("M.");
    expect(staged.path).toBe("staged only.txt");
    expect(staged.indexMode).toBe(0o100644);
    expect(staged.headMode).toBe(0o100644);
    expect(staged.worktreeMode).toBe(0o100644);

    expect(parsed.entries[1]!.xy).toBe(".M");

    const renamed = parsed.entries[2]!;
    expect(renamed.kind).toBe("renamed");
    expect(renamed.path).toBe("new name.ts");
    expect(renamed.origPath).toBe("old name.ts");
    expect(renamed.xy).toBe("R.");

    const unmerged = parsed.entries[3]!;
    expect(unmerged.kind).toBe("unmerged");
    expect(unmerged.xy).toBe("UU");
    expect(unmerged.path).toBe("both modified.txt");

    expect(parsed.entries[4]!.kind).toBe("untracked");
    expect(parsed.entries[4]!.path).toBe("untracked dir/");
    expect(parsed.entries[5]!.path).toBe("loose file.txt");
  });

  it("parses an empty-repo branch header", () => {
    const output = "# branch.oid (initial)\0# branch.head main\0";
    const parsed = parsePorcelainV2(output);
    expect(parsed.branch.head).toBe("main");
    expect(parsed.branch.oid).toBeNull();
    expect(parsed.entries).toEqual([]);
  });

  it("reports a detached branch header", () => {
    const parsed = parsePorcelainV2("# branch.head (detached)\0");
    expect(parsed.branch.detached).toBe(true);
    expect(parsed.branch.head).toBeNull();
  });
});

describe("status integration sanity", () => {
  it("parses real porcelain output for staged/dirty/untracked state", async () => {
    const fixture = track(
      await createGitFixture({
        committed: { "base.ts": "base\n" },
        staged: { "staged.ts": "staged\n" },
        dirty: { "dirty.ts": "dirty\n" },
        untracked: { "loose.txt": "loose\n" },
      }),
    );
    const adapter = createGitAdapter();
    const baseline = await adapter.captureBaseline(fixture.root);
    const paths = baseline.entries.map((entry) => entry.path);
    expect(paths).toEqual(["dirty.ts", "loose.txt", "staged.ts"]);
    expect(sha256("staged\n")).toBe(baseline.entries.find((e) => e.path === "staged.ts")!.hash);
  });

  it("hashes binary content exactly like node:crypto", async () => {
    const binary = new Uint8Array([0, 159, 146, 150, 0, 1, 2]);
    const fixture = track(await createGitFixture({ staged: { "blob.bin": binary } }));
    const baseline = await createGitAdapter().captureBaseline(fixture.root);
    const entry = baseline.entries.find((e) => e.path === "blob.bin")!;
    expect(entry.hash).toBe(sha256(binary));
  });
});
