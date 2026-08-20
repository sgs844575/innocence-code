/**
 * Private on-disk storage for InnocenceCode task data.
 *
 * Every path this package hands out lives under a caller-provided root and is
 * hardened on creation:
 * - POSIX: directories 0700, files 0600 (explicit chmod after create, so a
 *   restrictive umask can never widen access and a permissive one can never
 *   leak through).
 * - Windows: the root directory (and every directory segment this package
 *   creates) is restricted to the current user via `icacls /inheritance:r`
 *   plus an explicit grant for the current SID; files inherit that ACL.
 *
 * The package is deliberately generic (path management and file primitives
 * only) so P2/P3 can reuse it without task-domain knowledge.
 */
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const promisifiedExecFile = promisify(execFileCallback);

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Runs a command and returns its stdout/stderr; injectable for tests. */
export type ExecRunner = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

async function defaultExecFile(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return promisifiedExecFile(file, args as string[]);
}

/**
 * Canonical subpaths this package knows how to create. The fixed P1 task
 * layout (objects/checkpoints/events/backup/temp/apply-journal) plus the
 * cross-process lock trees live here so every producer agrees on names.
 */
export const SECURE_SUBDIRS = [
  "objects",
  "checkpoints",
  "events",
  "backup",
  "temp",
  "apply-journal",
  "locks",
  "locks/workspace",
  "locks/task",
] as const;

export type SecureSubdir = (typeof SECURE_SUBDIRS)[number];

export interface SecureStorageOptions {
  /** Subpaths to create eagerly (relative, "/"-separated). Default: all SECURE_SUBDIRS. */
  dirs?: readonly string[];
  /** Overrides process.platform; used by unit tests to pin a branch. */
  platform?: string;
  /** Injectable command runner (icacls/whoami) for unit tests. */
  execFile?: ExecRunner;
  /** Pre-resolved current-user SID; skips the `whoami` lookup when provided. */
  windowsSid?: string;
}

export interface ExclusiveCreateResult {
  path: string;
  created: boolean;
}

export interface SecureStorage {
  readonly root: string;
  /** Idempotently creates a secured directory under root and returns its absolute path. */
  ensureDir(relativePath: string): Promise<string>;
  /** Containment-checked absolute path for a relative entry; never creates anything. */
  resolve(relativePath: string): string;
  /** Like resolve() for a canonical subdirectory name (e.g. "locks/task"). */
  subdir(name: string): string;
  /** Creates a unique secured directory under `<root>/temp`. */
  createTempDir(prefix?: string): Promise<string>;
  /** Writes a 0600 file in place (fsync'd). Parent directory is created if needed. */
  writeFile(relativePath: string, content: string | Uint8Array): Promise<string>;
  /** Atomically installs a 0600 file via temp-write + fsync + rename. */
  writeFileAtomic(relativePath: string, content: string | Uint8Array): Promise<string>;
  /** Appends to a 0600 file (fsync'd), creating it when missing. */
  appendFile(relativePath: string, content: string | Uint8Array): Promise<string>;
  /** Creates a 0600 file only if it does not exist (O_EXCL semantics). */
  createFileExclusive(relativePath: string, content: string | Uint8Array): Promise<ExclusiveCreateResult>;
  readFile(relativePath: string): Promise<Uint8Array>;
  readTextFile(relativePath: string): Promise<string>;
  fileExists(relativePath: string): Promise<boolean>;
  /** Unlinks a file; a missing file is not an error. */
  deleteFile(relativePath: string): Promise<void>;
  /** Entry names of a directory under root (root itself when omitted). */
  listDir(relativePath?: string): Promise<string[]>;
}

/** True when `relativePath` is a safe "/"-separated relative path that cannot escape the root. */
export function isSafeRelativePath(relativePath: string): boolean {
  if (relativePath === "" || relativePath.length > 1024) {
    return false;
  }
  if (relativePath.includes("\0") || relativePath.includes("\\")) {
    return false;
  }
  if (relativePath.startsWith("/")) {
    return false;
  }
  if (/^[A-Za-z]:/.test(relativePath)) {
    return false;
  }
  const segments = relativePath.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

let cachedSid: string | null = null;

/** Resolves the current user's SID via `whoami` (cached per process). */
export async function currentProcessSid(exec: ExecRunner = defaultExecFile): Promise<string> {
  if (cachedSid !== null) {
    return cachedSid;
  }
  const { stdout } = await exec("whoami", ["/user", "/fo", "csv", "/nh"]);
  const match = stdout.match(/S-1-\d+(?:-\d+)*/);
  if (match === null) {
    throw new Error("secure-storage: unable to determine the current user SID");
  }
  cachedSid = match[0];
  return cachedSid;
}

interface StorageContext {
  root: string;
  platform: string;
  exec: ExecRunner;
  windowsSid?: string;
}

function assertSafe(relativePath: string): string {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`secure-storage: unsafe relative path: ${JSON.stringify(relativePath)}`);
  }
  return relativePath;
}

/** Restricts a freshly created (or just-opened root) directory to the current user. */
async function hardenDirectory(context: StorageContext, absolutePath: string): Promise<void> {
  if (context.platform === "win32") {
    const sid = context.windowsSid ?? (await currentProcessSid(context.exec));
    // Remove inherited ACEs, then grant the current user alone full control,
    // propagating to everything created below this directory.
    await context.exec("icacls", [absolutePath, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)(F)`]);
    return;
  }
  await fs.chmod(absolutePath, DIR_MODE);
}

async function openSecureFile(absolutePath: string, flag: string, content: string | Uint8Array): Promise<void> {
  const handle = await fs.open(absolutePath, flag, FILE_MODE);
  try {
    // Explicit chmod defeats both a widened and a narrowed umask.
    await handle.chmod(FILE_MODE);
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirAbsolute(context: StorageContext, absolutePath: string): Promise<void> {
  const relative = path.relative(context.root, absolutePath).split(path.sep).join("/");
  const segments = relative === "" ? [] : assertSafe(relative).split("/");
  let current = context.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let created = false;
    try {
      await fs.mkdir(current);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        continue; // created by a concurrent process; already hardened by its creator
      }
      throw error;
    }
    if (created) {
      await hardenDirectory(context, current);
    }
  }
}

/**
 * Opens (creating when absent) a hardened private storage root. The root is
 * re-hardened on every open so a pre-existing directory converges to the
 * current-user-only ACL; existing subdirectories are left untouched.
 */
export async function openSecureStorage(rootDir: string, options: SecureStorageOptions = {}): Promise<SecureStorage> {
  const context: StorageContext = {
    root: path.resolve(rootDir),
    platform: options.platform ?? process.platform,
    exec: options.execFile ?? defaultExecFile,
    windowsSid: options.windowsSid,
  };

  await fs.mkdir(context.root, { recursive: true });
  await hardenDirectory(context, context.root);

  const dirs = options.dirs ?? SECURE_SUBDIRS;
  for (const dir of dirs) {
    await ensureDirAbsolute(context, path.join(context.root, ...assertSafe(dir).split("/")));
  }

  const resolveEntry = (relativePath: string): string => {
    if (relativePath === "") {
      return context.root;
    }
    const safe = assertSafe(relativePath);
    return path.join(context.root, ...safe.split("/"));
  };

  const resolveStrict = (relativePath: string): string => {
    if (relativePath === "") {
      throw new Error("secure-storage: empty relative path");
    }
    return resolveEntry(relativePath);
  };

  const ensureParent = async (relativePath: string): Promise<string> => {
    const parent = path.posix.dirname(assertSafe(relativePath));
    const absolute = resolveEntry(relativePath);
    if (parent !== ".") {
      await ensureDirAbsolute(context, path.dirname(absolute));
    }
    return absolute;
  };

  return {
    root: context.root,

    async ensureDir(relativePath) {
      const absolute = resolveEntry(relativePath);
      await ensureDirAbsolute(context, absolute);
      return absolute;
    },

    resolve(relativePath: string): string {
      return resolveStrict(relativePath);
    },

    subdir(name: string): string {
      return resolveStrict(name);
    },

    async createTempDir(prefix = "tmp") {
      const tempRoot = resolveEntry("temp");
      await ensureDirAbsolute(context, tempRoot);
      const dir = await fs.mkdtemp(path.join(tempRoot, `${prefix}-`));
      if (context.platform !== "win32") {
        await fs.chmod(dir, DIR_MODE);
      }
      return dir;
    },

    async writeFile(relativePath, content) {
      const absolute = await ensureParent(relativePath);
      await openSecureFile(absolute, "w", content);
      return absolute;
    },

    async writeFileAtomic(relativePath, content) {
      const absolute = await ensureParent(relativePath);
      const tempRoot = resolveEntry("temp");
      await ensureDirAbsolute(context, tempRoot);
      const tempPath = path.join(tempRoot, `${randomUUID()}.tmp`);
      await openSecureFile(tempPath, "w", content);
      try {
        await fs.rename(tempPath, absolute);
      } catch (error) {
        await fs.rm(tempPath, { force: true });
        throw error;
      }
      return absolute;
    },

    async appendFile(relativePath, content) {
      const absolute = await ensureParent(relativePath);
      await openSecureFile(absolute, "a", content);
      return absolute;
    },

    async createFileExclusive(relativePath, content) {
      const absolute = await ensureParent(relativePath);
      try {
        await openSecureFile(absolute, "wx", content);
        return { path: absolute, created: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return { path: absolute, created: false };
        }
        throw error;
      }
    },

    async readFile(relativePath) {
      const buffer = await fs.readFile(resolveStrict(relativePath));
      return new Uint8Array(buffer);
    },

    async readTextFile(relativePath) {
      return fs.readFile(resolveStrict(relativePath), "utf8");
    },

    async fileExists(relativePath) {
      try {
        await fs.stat(resolveStrict(relativePath));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },

    async deleteFile(relativePath) {
      await fs.rm(resolveStrict(relativePath), { force: true });
    },

    async listDir(relativePath = "") {
      return fs.readdir(resolveEntry(relativePath));
    },
  };
}
