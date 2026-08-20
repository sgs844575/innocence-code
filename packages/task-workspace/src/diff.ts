/**
 * PatchEngine: diff between two workspace snapshots, reverse apply with a
 * durable journal, and three-way preflight.
 *
 * diff() reads file contents straight from the snapshot roots — no content
 * store required. applyReverse()/recoverApplyJournals() need a secure
 * storage (journal/backup/temp) and a content store (desired + backup
 * content) and throw when they were not provided.
 */
import fs from "node:fs/promises";
import type { SecureStorage } from "@innocencecode/secure-storage-node";
import type { FileSnapshotRef, Hunk } from "@innocencecode/task-core";
import type { ContentStore } from "./content-store.ts";
import { buildTextHunks } from "./hunks.ts";
import { readWorkspaceBytes } from "./scanner.ts";
import {
  applyReverse,
  preflightThreeWay,
  recoverJournals,
  type ApplyResult,
  type ConflictReport,
  type ReverseApplyInput,
  type ThreeWayInput,
} from "./apply.ts";
import type { RecoveryReport } from "./apply-journal.ts";

/** Default per-file text-diff budget; over-cap text degrades to file-level patches. */
export const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024;

export interface FilePatch {
  /** Workspace-relative path. */
  path: string;
  /** Pre-change state; exists:false when the file was absent. */
  before: FileSnapshotRef;
  /** Post-change state; exists:false when the file was deleted. */
  after: FileSnapshotRef;
  /** True when either side's content sniffed as binary. */
  binary: boolean;
  /**
   * Line hunks for in-budget text changes; empty (file-level patch) for
   * binary content, over-cap files, and deletions whose before-content is
   * no longer readable.
   */
  hunks: Hunk[];
}

export interface PatchEngine {
  diff(before: WorkspaceSnapshotLike, after: WorkspaceSnapshotLike): Promise<FilePatch[]>;
  applyReverse(input: ReverseApplyInput): Promise<ApplyResult>;
  preflightThreeWay(input: ThreeWayInput): Promise<ConflictReport>;
}

/** Minimal structural snapshot shape (scanner's WorkspaceSnapshot satisfies it). */
export interface WorkspaceSnapshotLike {
  root: string;
  files: FileSnapshotRef[];
}

export interface PatchEngineOptions {
  maxTextBytes?: number;
  storage?: SecureStorage;
  contentStore?: ContentStore;
}

export interface PatchEngineRuntime extends PatchEngine {
  /** Recovers interrupted apply transactions; see apply-journal.ts. */
  recoverApplyJournals(): Promise<RecoveryReport>;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

function absentRef(relativePath: string): FileSnapshotRef {
  return { path: relativePath, exists: false, hash: null, mode: null, binary: false };
}

/** Core diff over two snapshots; exported for reuse and testing. */
export async function diffSnapshots(
  before: WorkspaceSnapshotLike,
  after: WorkspaceSnapshotLike,
  maxTextBytes: number,
): Promise<FilePatch[]> {
  const beforeByPath = new Map(before.files.map((file) => [file.path, file]));
  const afterByPath = new Map(after.files.map((file) => [file.path, file]));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort();

  const patches: FilePatch[] = [];
  for (const relativePath of paths) {
    const beforeRef = beforeByPath.get(relativePath) ?? absentRef(relativePath);
    const afterRef = afterByPath.get(relativePath) ?? absentRef(relativePath);
    if (beforeRef.hash === afterRef.hash && beforeRef.exists === afterRef.exists) {
      continue; // unchanged
    }
    const binary = beforeRef.binary || afterRef.binary;
    let hunks: Hunk[] = [];
    if (!binary) {
      const beforeBytes = await readWorkspaceBytes(before.root, relativePath);
      const afterBytes = await readWorkspaceBytes(after.root, relativePath);
      const beforeSize = beforeBytes?.length ?? 0;
      const afterSize = afterBytes?.length ?? 0;
      // A deleted file's before content is gone from disk; over-cap text is
      // deliberately degraded — both stay file-level patches.
      if (beforeSize <= maxTextBytes && afterSize <= maxTextBytes && (beforeBytes !== null || afterBytes !== null)) {
        hunks = buildTextHunks(
          relativePath,
          beforeBytes === null ? "" : decoder.decode(beforeBytes),
          afterBytes === null ? "" : decoder.decode(afterBytes),
        );
      }
    }
    patches.push({ path: relativePath, before: beforeRef, after: afterRef, binary, hunks });
  }
  return patches;
}

export function createPatchEngine(options: PatchEngineOptions = {}): PatchEngineRuntime {
  const maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
  const deps = options.storage && options.contentStore ? { storage: options.storage, contentStore: options.contentStore } : null;

  const requireDeps = () => {
    if (deps === null) {
      throw new Error("patch engine: applyReverse/recovery require storage and contentStore options");
    }
    return deps;
  };

  return {
    async diff(before: WorkspaceSnapshotLike, after: WorkspaceSnapshotLike): Promise<FilePatch[]> {
      await fs.realpath(before.root);
      await fs.realpath(after.root);
      return diffSnapshots(before, after, maxTextBytes);
    },

    async applyReverse(input: ReverseApplyInput): Promise<ApplyResult> {
      return applyReverse(input, requireDeps());
    },

    async preflightThreeWay(input: ThreeWayInput): Promise<ConflictReport> {
      return preflightThreeWay(input);
    },

    async recoverApplyJournals(): Promise<RecoveryReport> {
      return recoverJournals(requireDeps());
    },
  };
}

export interface CheckpointDiffInput {
  /** Checkpoint (before) state: file refs plus a CAS reader for their content. */
  before: {
    files: readonly FileSnapshotRef[];
    readContent: (hash: string) => Promise<Uint8Array>;
  };
  /** Current (after) workspace state: a live root plus its scanned refs. */
  after: { root: string; files: readonly FileSnapshotRef[] };
}

/**
 * Checkpoint-vs-workspace diff (Task 13): the BEFORE content no longer exists
 * on disk once files changed, so it is read through the injected CAS reader
 * (content objects written when the checkpoint was taken); after-content is
 * read from the live workspace root. Binary sniffing and the text budget
 * follow the refs, exactly like diffSnapshots.
 */
export async function diffCheckpointToWorkspace(
  input: CheckpointDiffInput,
  maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
): Promise<FilePatch[]> {
  const beforeByPath = new Map(input.before.files.map((file) => [file.path, file]));
  const afterByPath = new Map(input.after.files.map((file) => [file.path, file]));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort();

  const patches: FilePatch[] = [];
  for (const relativePath of paths) {
    const beforeRef = beforeByPath.get(relativePath) ?? absentRef(relativePath);
    const afterRef = afterByPath.get(relativePath) ?? absentRef(relativePath);
    if (beforeRef.hash === afterRef.hash && beforeRef.exists === afterRef.exists) {
      continue; // unchanged
    }
    const binary = beforeRef.binary || afterRef.binary;
    let hunks: Hunk[] = [];
    if (!binary) {
      let beforeBytes: Uint8Array | null = null;
      if (beforeRef.hash !== null) {
        beforeBytes = await input.before.readContent(beforeRef.hash);
      }
      const afterBytes = await readWorkspaceBytes(input.after.root, relativePath);
      const beforeSize = beforeBytes?.length ?? 0;
      const afterSize = afterBytes?.length ?? 0;
      if (beforeSize <= maxTextBytes && afterSize <= maxTextBytes && (beforeBytes !== null || afterBytes !== null)) {
        hunks = buildTextHunks(
          relativePath,
          beforeBytes === null ? "" : decoder.decode(beforeBytes),
          afterBytes === null ? "" : decoder.decode(afterBytes),
        );
      }
    }
    patches.push({ path: relativePath, before: beforeRef, after: afterRef, binary, hunks });
  }
  return patches;
}
