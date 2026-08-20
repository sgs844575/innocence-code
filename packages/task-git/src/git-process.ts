/**
 * Safe Git CLI process wrapper.
 *
 * Every invocation goes through an allowlist of read-only probes plus the two
 * worktree verbs the task workflow needs; a forbidden or unknown verb throws
 * before anything is spawned. Commands run with spawn(executable, args,
 * { cwd, shell: false }) — no shell, no string concatenation. stdout/stderr
 * are capped and an AbortSignal can cancel a running command at any time.
 */
import { spawn } from "node:child_process";

/** Default cap for stdout/stderr (4 MiB per stream). */
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Maximum characters kept from stderr in error messages. */
const STDERR_EXCERPT_CHARS = 2000;

export interface GitSpawnOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Cap per output stream in bytes; default 4 MiB. */
  maxOutputBytes?: number;
}

export interface GitSpawnResult {
  stdout: Buffer;
  stderr: string;
}

/** Thrown when a git invocation is not on the adapter allowlist. */
export class GitCommandRefusedError extends Error {
  constructor(command: string) {
    super(`task-git: forbidden git invocation: ${command}`);
    this.name = "GitCommandRefusedError";
  }
}

/** Thrown when git fails, is aborted, or overflows the output cap. */
export class GitProcessError extends Error {
  /** The refused/failed invocation, e.g. "git rev-parse HEAD". */
  readonly command: string;
  /** Capped, control-char-stripped stderr excerpt (may be empty). */
  readonly stderr: string;
  /** Process exit code when the command actually ran. */
  readonly exitCode: number | null;

  constructor(message: string, command: string, stderr = "", exitCode: number | null = null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitProcessError";
    this.command = command;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

function arg(args: readonly string[], index: number): string {
  return args[index] ?? "";
}

/**
 * True when the argument vector is an allowed git invocation. The allowlist
 * covers the read-only probes (rev-parse/status/branch/ls-files/diff/
 * hash-object without -w) and the worktree verbs (add --detach, list
 * --porcelain, remove --force, prune). `git init/config/commit/...` are
 * deliberately absent: fixtures and host code must never reach them through
 * the adapter.
 */
export function isAllowedGitInvocation(args: readonly string[]): boolean {
  const [a0, a1, a2, a3] = [arg(args, 0), arg(args, 1), arg(args, 2), arg(args, 3)];
  switch (a0) {
    case "rev-parse":
      return a1 === "--show-toplevel" || (a1 === "HEAD" && args.length === 2);
    case "status":
      return a1 === "--porcelain=v2" && a2 === "-z" && a3 === "--branch" && args.length === 4;
    case "branch":
      return a1 === "--show-current" && args.length === 2;
    case "ls-files":
      return a1 === "-s" && args.length === 2;
    case "diff":
      return a1 === "--cached" && args.length === 2;
    case "hash-object":
      // read-only hash computation; -w/--write would create objects
      return !args.slice(1).some((flag) => flag === "-w" || flag === "--write");
    case "worktree":
      if (a1 === "add") {
        // git worktree add --detach <path> [commit]
        return a2 === "--detach" && (args.length === 4 || args.length === 5);
      }
      if (a1 === "list") {
        return a2 === "--porcelain" && args.length === 3;
      }
      if (a1 === "remove") {
        return a2 === "--force" && args.length === 4;
      }
      return a1 === "prune" && args.length === 2;
    default:
      return false;
  }
}

export function assertAllowedGitInvocation(args: readonly string[]): void {
  if (!isAllowedGitInvocation(args)) {
    throw new GitCommandRefusedError(`git ${args.join(" ")}`);
  }
}

/** Strips control characters (except newline/tab) and caps the excerpt. */
export function stderrExcerpt(stderr: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = stderr.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").trim();
  return stripped.length > STDERR_EXCERPT_CHARS ? stripped.slice(0, STDERR_EXCERPT_CHARS) : stripped;
}

/**
 * Runs one allowlisted git command. Never uses a shell; output streams are
 * capped (the child is killed on overflow); an aborted signal kills the
 * child or refuses to start.
 */
export async function runGit(executable: string, args: readonly string[], options: GitSpawnOptions): Promise<GitSpawnResult> {
  assertAllowedGitInvocation(args);
  const command = `${executable} ${args.join(" ")}`;
  const cap = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  if (options.signal?.aborted) {
    throw new GitProcessError(`task-git: aborted before start: ${command}`, command);
  }

  return new Promise<GitSpawnResult>((resolve, reject) => {
    const child = spawn(executable, [...args], { cwd: options.cwd, shell: false });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    let aborted = false;
    let settled = false;

    const fail = (error: GitProcessError): void => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    };

    const onAbort = (): void => {
      aborted = true;
      child.kill();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > cap) {
        overflowed = true;
        child.kill();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > cap) {
        overflowed = true;
        child.kill();
        return;
      }
      stderrChunks.push(chunk);
    });

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error: NodeJS.ErrnoException) => {
      fail(new GitProcessError(`task-git: failed to run ${command}: ${error.message}`, command, "", null, { cause: error }));
    });

    child.on("close", (code: number | null) => {
      if (settled) {
        return;
      }
      const stderr = stderrExcerpt(Buffer.concat(stderrChunks).toString("utf8"));
      if (overflowed) {
        fail(new GitProcessError(`task-git: output exceeded ${cap} bytes for ${command}`, command, stderr, code));
        return;
      }
      if (aborted) {
        fail(new GitProcessError(`task-git: aborted: ${command}`, command, stderr, code));
        return;
      }
      if (code !== 0) {
        fail(
          new GitProcessError(
            `task-git: ${command} failed with exit code ${code ?? "unknown"}${stderr === "" ? "" : `: ${stderr}`}`,
            command,
            stderr,
            code,
          ),
        );
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr });
    });
  });
}

/** Signature every adapter module uses to reach git (injectable for tests). */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitSpawnResult>;

export interface GitRunnerDefaults {
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

/** Creates a GitRunner bound to an executable and default spawn options. */
export function createGitRunner(executable: string, defaults: GitRunnerDefaults = {}): GitRunner {
  return (args: readonly string[], cwd: string) =>
    runGit(executable, args, {
      cwd,
      maxOutputBytes: defaults.maxOutputBytes,
      signal: defaults.signal,
    });
}
