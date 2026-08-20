/**
 * Workspace watcher.
 *
 * Reports workspace changes with RELATIVE paths, before/after content
 * hashes and a timestamp, always with source "unknown": attributing a
 * change to task-owned edits, external edits, or a conflict is the
 * CALLER's decision — the watcher never guesses.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { sha256Bytes } from "./content-store.ts";
import { scanWorkspace } from "./scanner.ts";

export interface WorkspaceFileEvent {
  /** Workspace-relative, "/"-separated path. */
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  timestamp: number;
  source: "unknown";
}

export interface WorkspaceWatcherOptions {
  onEvent(event: WorkspaceFileEvent): void;
  /** Return true to exclude a relative path from watching (e.g. .git). */
  ignore?: (relativePath: string) => boolean;
}

export interface WorkspaceWatcher {
  /** Starts watching; resolves once the baseline scan and chokidar are ready. */
  start(): Promise<void>;
  /** Closes the watcher; safe to call multiple times. */
  stop(): Promise<void>;
}

export function createWorkspaceWatcher(root: string, options: WorkspaceWatcherOptions): WorkspaceWatcher {
  let watcher: FSWatcher | null = null;
  let canonicalRoot: string | null = null;
  const known = new Map<string, string | null>();
  let queue: Promise<void> = Promise.resolve();

  const toRelative = (absolutePath: string): string | null => {
    if (canonicalRoot === null) {
      return null;
    }
    const relative = path.relative(canonicalRoot, absolutePath).split(path.sep).join("/");
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }
    return relative;
  };

  const emit = (relativePath: string, afterHash: string | null): void => {
    const beforeHash = known.get(relativePath) ?? null;
    // Suppress no-op transitions: watchers often report the same write twice
    // (add + change) and a duplicated unlink; hash equality proves no change.
    if (beforeHash === afterHash) {
      return;
    }
    options.onEvent({
      path: relativePath,
      beforeHash,
      afterHash,
      timestamp: Date.now(),
      source: "unknown",
    });
    if (afterHash === null) {
      known.delete(relativePath);
    } else {
      known.set(relativePath, afterHash);
    }
  };

  const handleChange = (absolutePath: string): void => {
    const relativePath = toRelative(absolutePath);
    if (relativePath === null || options.ignore?.(relativePath)) {
      return;
    }
    queue = queue.then(async () => {
      try {
        const content = new Uint8Array(await fs.readFile(absolutePath));
        emit(relativePath, sha256Bytes(content));
      } catch {
        // the file vanished mid-event; the unlink event will follow
      }
    });
  };

  const handleUnlink = (absolutePath: string): void => {
    const relativePath = toRelative(absolutePath);
    if (relativePath === null || options.ignore?.(relativePath)) {
      return;
    }
    queue = queue.then(() => {
      emit(relativePath, null);
    });
  };

  return {
    async start(): Promise<void> {
      if (watcher !== null) {
        return;
      }
      canonicalRoot = await fs.realpath(root);
      const baseline = await scanWorkspace(canonicalRoot);
      for (const file of baseline.files) {
        known.set(file.path, file.hash);
      }
      watcher = watch(canonicalRoot, {
        ignoreInitial: true,
        followSymlinks: false,
        ignored: (absolutePath: string) => {
          const relativePath = toRelative(absolutePath);
          return relativePath !== null && (options.ignore?.(relativePath) ?? false);
        },
      });
      await new Promise<void>((resolve, reject) => {
        const instance = watcher!;
        instance.on("error", reject);
        instance.on("ready", () => resolve());
      });
      watcher.on("add", handleChange);
      watcher.on("change", handleChange);
      watcher.on("unlink", handleUnlink);
    },

    async stop(): Promise<void> {
      const instance = watcher;
      watcher = null;
      if (instance !== null) {
        await instance.close();
      }
      await queue;
    },
  };
}
