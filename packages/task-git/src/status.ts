/**
 * Workspace detection and porcelain v2 status parsing.
 *
 * detect() answers "is this a Git workspace and where is its toplevel" using
 * only allowed probes (rev-parse --show-toplevel / HEAD, branch
 * --show-current). Non-Git directories throw GitWorkspaceError — the caller
 * decides whether to degrade to a snapshot workspace. parsePorcelainV2()
 * turns `git status --porcelain=v2 -z --branch` output (NUL-separated
 * records, rename origPath in a separate token) into structured entries.
 */
import path from "node:path";
import type { GitRunner } from "./git-process.ts";
import { GitProcessError } from "./git-process.ts";

export interface GitWorkspaceInfo {
  kind: "git";
  /** Absolute repository toplevel ("C:/..."-style paths are normalized). */
  root: string;
  /** HEAD commit id; null for a repository without commits. */
  headCommit: string | null;
  /** Current branch name; null when HEAD is detached. */
  branch: string | null;
}

/** Thrown when a directory is not inside a Git repository. */
export class GitWorkspaceError extends Error {
  readonly code = "NOT_A_GIT_REPOSITORY";

  constructor(message: string) {
    super(message);
    this.name = "GitWorkspaceError";
  }
}

const COMMIT_ID = /^[0-9a-f]{40}$/;

/** Detects the Git workspace for any directory inside a repository. */
export async function detectGit(git: GitRunner, root: string): Promise<GitWorkspaceInfo> {
  let toplevel: string;
  try {
    toplevel = (await git(["rev-parse", "--show-toplevel"], root)).stdout.toString("utf8").trim();
  } catch (error) {
    if (error instanceof GitProcessError && /not a git repository/i.test(error.stderr)) {
      throw new GitWorkspaceError(`task-git: not a Git repository: ${root}`);
    }
    throw error;
  }

  let headCommit: string | null = null;
  try {
    const head = (await git(["rev-parse", "HEAD"], root)).stdout.toString("utf8").trim();
    headCommit = COMMIT_ID.test(head) ? head : null;
  } catch {
    headCommit = null; // empty repository: unborn HEAD
  }

  let branch: string | null = null;
  try {
    branch = (await git(["branch", "--show-current"], root)).stdout.toString("utf8").trim() || null;
  } catch {
    branch = null;
  }

  return { kind: "git", root: path.resolve(toplevel), headCommit, branch };
}

export interface PorcelainBranchInfo {
  head: string | null;
  detached: boolean;
  oid: string | null;
  upstream: string | null;
  ab: string | null;
}

export type PorcelainEntryKind = "ordinary" | "renamed" | "unmerged" | "untracked";

export interface PorcelainChangeEntry {
  kind: PorcelainEntryKind;
  /** Final path; for renames the NEW path. Untracked dirs keep the trailing "/". */
  path: string;
  /** Rename/copy source path, only for kind === "renamed". */
  origPath: string | null;
  /** Porcelain v2 XY codes ("??" for untracked). */
  xy: string;
  headMode: number | null;
  indexMode: number | null;
  worktreeMode: number | null;
}

export interface PorcelainStatus {
  branch: PorcelainBranchInfo;
  entries: PorcelainChangeEntry[];
}

function parseMode(field: string | undefined): number | null {
  return field !== undefined && /^[0-7]{6}$/.test(field) ? parseInt(field, 8) : null;
}

/**
 * Splits off `fieldCount` space-separated fields and returns everything after
 * them unchanged (the record path may contain spaces; unlike
 * String.split, the remainder is preserved).
 */
function splitRecord(token: string, fieldCount: number): { fields: string[]; rest: string } {
  let index = -1;
  for (let field = 0; field < fieldCount; field += 1) {
    index = token.indexOf(" ", index + 1);
    if (index === -1) {
      return { fields: token.split(" "), rest: "" };
    }
  }
  return { fields: token.slice(0, index).split(" "), rest: token.slice(index + 1) };
}

/**
 * Parses `git status --porcelain=v2 -z --branch` output. With -z every
 * record — headers included — is NUL-terminated, and a rename record's
 * origPath is a separate NUL token right after the record itself.
 */
export function parsePorcelainV2(output: string): PorcelainStatus {
  const tokens = output.split("\0").filter((token) => token !== "");
  const branch: PorcelainBranchInfo = { head: null, detached: false, oid: null, upstream: null, ab: null };
  const entries: PorcelainChangeEntry[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;

    if (token.startsWith("# ")) {
      const header = token.slice(2);
      if (header.startsWith("branch.head ")) {
        const value = header.slice("branch.head ".length);
        if (value === "(detached)") {
          branch.detached = true;
        } else {
          branch.head = value;
        }
      } else if (header.startsWith("branch.oid ")) {
        const oid = header.slice("branch.oid ".length);
        branch.oid = COMMIT_ID.test(oid) ? oid : null;
      } else if (header.startsWith("branch.upstream ")) {
        branch.upstream = header.slice("branch.upstream ".length);
      } else if (header.startsWith("branch.ab ")) {
        branch.ab = header.slice("branch.ab ".length);
      }
      continue;
    }

    if (token.startsWith("? ")) {
      entries.push({
        kind: "untracked",
        path: token.slice(2),
        origPath: null,
        xy: "??",
        headMode: null,
        indexMode: null,
        worktreeMode: null,
      });
      continue;
    }

    // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — path may contain spaces
    if (token.startsWith("1 ")) {
      const { fields, rest } = splitRecord(token, 8);
      entries.push({
        kind: "ordinary",
        path: rest,
        origPath: null,
        xy: fields[1] ?? "",
        headMode: parseMode(fields[3]),
        indexMode: parseMode(fields[4]),
        worktreeMode: parseMode(fields[5]),
      });
      continue;
    }

    // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` + NUL + origPath
    if (token.startsWith("2 ")) {
      const { fields, rest } = splitRecord(token, 9);
      index += 1; // the next token is the rename source, not a record
      entries.push({
        kind: "renamed",
        path: rest,
        origPath: tokens[index] ?? null,
        xy: fields[1] ?? "",
        headMode: parseMode(fields[3]),
        indexMode: parseMode(fields[4]),
        worktreeMode: parseMode(fields[5]),
      });
      continue;
    }

    // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
    if (token.startsWith("u ")) {
      const { fields, rest } = splitRecord(token, 10);
      entries.push({
        kind: "unmerged",
        path: rest,
        origPath: null,
        xy: fields[1] ?? "",
        headMode: null,
        indexMode: null, // ambiguous while stages differ
        worktreeMode: parseMode(fields[6]),
      });
    }
  }

  return { branch, entries };
}

/** Reads the current porcelain v2 status for a repository. */
export async function readGitStatus(git: GitRunner, cwd: string): Promise<PorcelainStatus> {
  const result = await git(["status", "--porcelain=v2", "-z", "--branch"], cwd);
  return parsePorcelainV2(result.stdout.toString("utf8"));
}
