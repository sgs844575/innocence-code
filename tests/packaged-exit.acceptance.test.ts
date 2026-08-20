// P1 packaged-exit acceptance (Task 14 fix): proves "打包后的主进程退出时无
// MCP/PTY/锁 lease 残留" against the REAL packaged executable. Packaged
// Electron exes always boot the real app (app-path args are ignored), so the
// committed smoke entry (src/main/packageSmoke.ts -> .vite/build/smoke.js
// inside app.asar) runs through the packaged exe under ELECTRON_RUN_AS_NODE,
// extracted from the packaged asar, with `node-pty` resolving to the
// packaged app.asar.unpacked binaries via a junction. It drives a REAL PTY
// (create/dispose) and a REAL command-service mutation (the task/workspace
// lease pair), then exits 0. This test asserts the exit contract and sweeps
// for residue AFTER exit:
//   - no process whose executable image lives in the packaged tree (winpty /
//     conpty agents, OpenConsole, any spawned child) survives,
//   - no lock lease files remain under the temp userData (both lock kinds
//     delete their file on release — a survivor is a leak),
//   - MCP servers only start when configured and the fresh temp userData
//     configures none, so the process sweep is also the no-MCP-spawn proof.
//
// Run with `npm run package:smoke` AFTER `npm run package`. The test SKIPS
// with a clear reason when no packaged build (or a build predating the smoke
// entry) is present, so plain `npm test` stays green on clean checkouts.
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, symlinkSync, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import url from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const packageDir = process.env.IC_PACKAGE_DIR
  ? path.resolve(process.env.IC_PACKAGE_DIR)
  : path.join(repoRoot, "out", "InnocenceCode-win32-x64");
const packagedExe = path.join(packageDir, "InnocenceCode.exe");
const asarPath = path.join(packageDir, "resources", "app.asar");
const unpackedNodeModules = path.join(packageDir, "resources", "app.asar.unpacked", "node_modules");

/** The packaged build must expose the smoke entry inside app.asar. */
function packagedSmokeAvailable(): boolean {
  if (!existsSync(packagedExe) || !existsSync(asarPath)) return false;
  try {
    return smokeEntryKey() !== null;
  } catch {
    return false; // @electron/asar unavailable — cannot verify the entry
  }
}

/** Archive key of the smoke entry (archive keys keep the platform separator). */
function smokeEntryKey(): string | null {
  const asar = createRequire(import.meta.url)("@electron/asar") as AsarApi;
  return (
    asar.listPackage(asarPath).find((entry) => entry.replaceAll("\\", "/").endsWith("/.vite/build/smoke.js")) ?? null
  );
}

interface AsarApi {
  listPackage: (archive: string) => string[];
  extractAll: (archive: string, dest: string) => void;
}

/**
 * Extracts the packaged app archive into a temp stage dir, keeps the bundled
 * smoke entry (+ its shared chunk) and junctions node_modules to the packaged
 * unpacked tree, so the smoke's require("node-pty") loads the binaries that
 * actually ship in the package. (extractAll: this archive's keys carry the
 * platform separator, which extractFile's "/"-split lookup cannot address.)
 */
async function stageSmokeEntry(stageDir: string): Promise<string> {
  const asar = createRequire(import.meta.url)("@electron/asar") as AsarApi;
  asar.extractAll(asarPath, stageDir);
  const smokeFile = path.join(stageDir, ".vite", "build", "smoke.js");
  if (!existsSync(smokeFile)) throw new Error("smoke entry missing from the packaged archive");
  const smokeSource = await fs.readFile(smokeFile, "utf8");
  const chunk = smokeSource.match(/require\("\.\/(src-[^"]+\.js)"\)/)?.[1];
  if (chunk !== undefined && !existsSync(path.join(stageDir, ".vite", "build", chunk))) {
    throw new Error(`shared chunk missing from the packaged archive: ${chunk}`);
  }
  // Prefer the package's REAL unpacked natives over the extracted copies.
  await fs.rm(path.join(stageDir, "node_modules"), { recursive: true, force: true });
  symlinkSync(unpackedNodeModules, path.join(stageDir, "node_modules"), "junction");
  return smokeFile;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 75 * 2 ** attempt));
      }
    }
  });
  return dir;
}

/** Executable paths of every running process (empty for inaccessible ones). */
async function processImagePaths(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "wmic",
    ["process", "get", "ExecutablePath", "/format:csv"],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.split(",").filter((field) => field !== "").at(-1) ?? "")
    .filter((value) => value.trim().length > 0);
}

/** Every *.lock file under a root (task/workspace lease residue). */
async function lockFilesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // absent directory — nothing leaked there
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (entry.name.endsWith(".lock")) {
        found.push(absolute);
      }
    }
  }
  await walk(root);
  return found;
}

const maybeIt = packagedSmokeAvailable() ? it : it.skip;

describe("packaged-exit acceptance (requires `npm run package` first)", () => {
  maybeIt("the packaged main drives a PTY and the task lease pair, then exits with no residue", async () => {
    const stageDir = await tempDir("ic-pkgstage-");
    const userdataDir = await tempDir("ic-pkgsmoke-");
    const smokeEntryFile = await stageSmokeEntry(stageDir);

    const child = spawn(packagedExe, [smokeEntryFile, `--smoke-user-data=${userdataDir}`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    const timeout = setTimeout(() => {
      void execFileAsync("taskkill", ["/T", "/F", "/PID", String(child.pid)]).catch(() => undefined);
    }, 120_000);
    const exitCode = await exited;
    clearTimeout(timeout);

    const evidence = `exit=${exitCode}\n${stdout.trim()}\n${stderr.trim()}`.trim();
    console.log(`[packaged-exit] ${path.basename(packageDir)}\n[packaged-exit] ${evidence}`);
    expect(exitCode, `smoke output:\n${evidence}`).toBe(0);
    expect(stdout).toContain("PKG_SMOKE pty ok");
    expect(stdout).toContain("PKG_SMOKE task ok");
    expect(stdout).toContain("PKG_SMOKE lockfiles 0");
    expect(stdout).toContain("PKG_SMOKE done");
    expect(stdout).not.toContain("PKG_SMOKE fail");

    // residue sweep 1: the lease machinery ran (its directories exist under
    // the temp storage) and no lease file survived the exit
    const locksRoot = path.join(userdataDir, "task-storage", "locks");
    expect(await fs.stat(path.join(locksRoot, "workspace")).then(() => true, () => false)).toBe(true);
    expect(await fs.stat(path.join(locksRoot, "task")).then(() => true, () => false)).toBe(true);
    const leakedLocks = await lockFilesUnder(locksRoot);
    expect(leakedLocks, "lock lease files must not survive the packaged exit").toEqual([]);

    // residue sweep 2: a beat after exit, no process image from the packaged
    // tree (winpty/conpty agents, OpenConsole, spawned children) survives
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const packageDirLower = packageDir.toLowerCase();
    const agentBasenames = new Set(["winpty-agent.exe", "openconsole.exe", "conpty.exe"]);
    const residuals = (await processImagePaths()).filter((image) => {
      const lower = image.toLowerCase();
      return (
        lower.startsWith(packageDirLower) ||
        lower.includes("app.asar.unpacked") ||
        agentBasenames.has(path.basename(lower))
      );
    });
    expect(residuals, "no packaged-tree process may survive the exit").toEqual([]);
    console.log("[packaged-exit] residue sweep clean (no processes, no lock leases)");
  }, 180_000);
});

if (!packagedSmokeAvailable()) {
  // A visible reason next to the skip (vitest shows it.skip without one).
  it.skip("packaged build not found — run `npm run package` then `npm run package:smoke`", () => {});
}
