/**
 * Workspace snapshot scanner.
 *
 * Walks a workspace root and records one FileSnapshotRef per regular file:
 * exists/hash(sha256)/mode/binary. Paths in snapshots are ALWAYS relative and
 * "/"-separated. Symlinks and junctions (which lstat reports as symlinks on
 * Windows) are out of scope: they are never followed and never recorded, so a
 * link cannot smuggle content from outside the workspace into a snapshot.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { FileSnapshotRef } from "@innocencecode/task-core";
import { isSafeRelativePath } from "@innocencecode/secure-storage-node";
import { sha256Bytes } from "./content-store.ts";

export { isSafeRelativePath } from "@innocencecode/secure-storage-node";

export interface WorkspaceSnapshot {
  /** Canonical (realpath) workspace root. */
  root: string;
  /** One entry per in-scope regular file, sorted by relative path. */
  files: FileSnapshotRef[];
}

export interface ScanOptions {
  signal?: AbortSignal;
}

/** NUL byte within the first 8000 bytes marks content as binary (git heuristic). */
export const BINARY_SNIFF_BYTES = 8000;

export function looksBinary(content: Uint8Array): boolean {
  const limit = Math.min(content.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (content[index] === 0) {
      return true;
    }
  }
  return false;
}

/** Containment-checked join of a validated relative path onto a workspace root. */
export function resolveWorkspaceFile(root: string, relativePath: string): string {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`workspace: unsafe relative path: ${JSON.stringify(relativePath)}`);
  }
  return path.join(root, ...relativePath.split("/"));
}

/** Reads workspace bytes; null when the file does not exist. */
export async function readWorkspaceBytes(root: string, relativePath: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await fs.readFile(resolveWorkspaceFile(root, relativePath)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Current sha256 of a workspace file; null when it does not exist. */
export async function diskHash(root: string, relativePath: string): Promise<string | null> {
  const content = await readWorkspaceBytes(root, relativePath);
  return content === null ? null : sha256Bytes(content);
}

export async function scanWorkspace(root: string, options: ScanOptions = {}): Promise<WorkspaceSnapshot> {
  const canonicalRoot = await fs.realpath(root);
  const files: FileSnapshotRef[] = [];

  async function walk(dirAbsolute: string, dirRelative: string): Promise<void> {
    if (options.signal?.aborted) {
      throw new Error("scan aborted");
    }
    const entries = await fs.readdir(dirAbsolute, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = dirRelative === "" ? entry.name : `${dirRelative}/${entry.name}`;
      const absolute = path.join(dirAbsolute, entry.name);
      const lstat = await fs.lstat(absolute);
      if (lstat.isSymbolicLink()) {
        continue; // symlink or junction: out of scope, never followed
      }
      if (lstat.isDirectory()) {
        await walk(absolute, relativePath);
        continue;
      }
      if (!lstat.isFile()) {
        continue; // sockets, fifos, devices: not workspace content
      }
      const content = new Uint8Array(await fs.readFile(absolute));
      files.push({
        path: relativePath,
        exists: true,
        hash: sha256Bytes(content),
        mode: lstat.mode & 0o7777,
        binary: looksBinary(content),
      });
    }
  }

  await walk(canonicalRoot, "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root: canonicalRoot, files };
}
