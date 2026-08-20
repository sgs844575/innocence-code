/**
 * @innocencecode/task-git — Git worktree/baseline/apply adapter.
 *
 * Talks to Git exclusively through allowlisted CLI invocations
 * (spawn, shell:false); never mutates the index, never stashes, never
 * creates commits or hidden refs. Task state persistence is NOT here — it
 * belongs to the task directory repository.
 */
export * from "./git-process.ts";
export * from "./status.ts";
export * from "./baseline.ts";
export * from "./worktree.ts";
export * from "./apply.ts";
import { createGitRunner, type GitRunner } from "./git-process.ts";
import { captureBaseline, overlayBaselineAt, type GitBaseline } from "./baseline.ts";
import { detectGit, type GitWorkspaceInfo } from "./status.ts";
import {
  closeLease as closeLeaseOnDisk,
  createWorktree as createWorktreeFor,
  destroyWorktree as destroyRegisteredWorktree,
  recoverWorktree as recoverRegisteredWorktree,
  type CreateWorktreeInput,
  type RecoverWorktreeInput,
  type WorktreeLease,
} from "./worktree.ts";
import {
  applyAccepted as applyAcceptedPatch,
  preflightApply as preflightApplyPatch,
  type ApplyAcceptedInput,
  type ApplyResult,
  type ConflictReport,
} from "./apply.ts";

export interface GitAdapter {
  detect(root: string): Promise<GitWorkspaceInfo>;
  captureBaseline(root: string): Promise<GitBaseline>;
  createWorktree(input: CreateWorktreeInput): Promise<WorktreeLease>;
  overlayBaseline(lease: WorktreeLease, baseline: GitBaseline): Promise<void>;
  preflightApply(input: ApplyAcceptedInput): Promise<ConflictReport>;
  applyAccepted(input: ApplyAcceptedInput): Promise<ApplyResult>;
  closeLease(lease: WorktreeLease): Promise<void>;
  recoverWorktree(input: RecoverWorktreeInput): Promise<WorktreeLease>;
  destroyWorktree(lease: WorktreeLease): Promise<void>;
}

export interface GitAdapterOptions {
  /** Git executable; default "git". */
  gitPath?: string;
  /** Per-stream output cap override (default 4 MiB). */
  maxOutputBytes?: number;
  /** Signal aborting every invocation made through this adapter. */
  signal?: AbortSignal;
}

/** Creates a GitAdapter bound to an executable and default spawn options. */
export function createGitAdapter(options: GitAdapterOptions = {}): GitAdapter {
  const git: GitRunner = createGitRunner(options.gitPath ?? "git", {
    maxOutputBytes: options.maxOutputBytes,
    signal: options.signal,
  });

  return {
    detect: (root) => detectGit(git, root),
    captureBaseline: (root) => captureBaseline(git, root),
    createWorktree: (input) => createWorktreeFor(git, input),
    overlayBaseline: (lease, baseline) => overlayBaselineAt(lease.path, baseline),
    preflightApply: (input) => preflightApplyPatch(git, input),
    applyAccepted: (input) => applyAcceptedPatch(git, input),
    closeLease: closeLeaseOnDisk,
    recoverWorktree: (input) => recoverRegisteredWorktree(git, input),
    destroyWorktree: (lease) => destroyRegisteredWorktree(git, lease),
  };
}
