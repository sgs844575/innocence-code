/**
 * Packaged-exit smoke entry (Task 14 fix): a SECOND main-process entry that
 * ships inside the packaged bundle (`.vite/build/smoke.js` inside app.asar).
 * `npm run package:smoke` runs it through the REAL packaged executable and
 * proves the main process can drive a real PTY and the task lock pair and
 * then exit with NO residue: no lingering PTY agent processes, no leaked
 * lock lease files, and (MCP servers only start when configured — a fresh
 * temp userData configures none) no spawned server processes.
 *
 * Because packaged Electron executables always boot the real app (they
 * ignore app-path arguments), the smoke runs under ELECTRON_RUN_AS_NODE:
 * the entry is extracted from the packaged app.asar and its `node-pty`
 * resolves to the packaged app.asar.unpacked binaries. The entry is
 * therefore Electron-OPTIONAL — under a dev `electron smoke.js` it uses the
 * Electron app lifecycle; under RUN_AS_NODE it runs plain-Node and exits via
 * process.exit. It NEVER creates a window and never touches real user data.
 *
 * Contract with tests/packaged-exit.acceptance.test.ts:
 *   args:                <this-file> --smoke-user-data=<dir>
 *   stdout markers:      "PKG_SMOKE pty ok" | "PKG_SMOKE task ok" |
 *                        "PKG_SMOKE lockfiles <n>" | "PKG_SMOKE done" (exit 0)
 *   failure:             "PKG_SMOKE fail <reason>" (exit 1)
 */
import fs from "node:fs";
import path from "node:path";
import { createPtyManager } from "@innocencecode/terminal-pty";
import { collectStructuredOutput, createTaskCliAdapter, createTaskCliRuntime } from "@innocencecode/task-cli";

const SMOKE_TIMEOUT_MS = 90_000;

/** The Electron app object, or null under ELECTRON_RUN_AS_NODE. */
interface ElectronLikeApp {
  setPath(name: string, target: string): void;
  whenReady(): Promise<unknown>;
  exit(code: number): void;
}

function loadElectronApp(): ElectronLikeApp | null {
  try {
    // Plain `require` (not an import): under RUN_AS_NODE the electron
    // built-in is absent and this must throw into the catch, not tear the
    // module apart at load time.
    const electron = require("electron") as { app?: ElectronLikeApp };
    return electron.app ?? null;
  } catch {
    return null;
  }
}

function fail(reason: string): never {
  console.log(`PKG_SMOKE fail ${reason}`);
  const app = loadElectronApp();
  if (app !== null) {
    app.exit(1);
  }
  process.exit(1);
  throw new Error(reason);
}

function collectLockFiles(root: string): string[] {
  const found: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no locks tree at all — nothing leaked
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (entry.name.endsWith(".lock")) {
        found.push(absolute);
      }
    }
  }
  walk(root);
  return found;
}

async function main(userdataDir: string): Promise<void> {
  // -- 1. real PTY create -> output -> dispose (winpty/conpty agents spawn,
  //        then must die with dispose; the outer test enumerates them) ------
  const ptyManager = createPtyManager({ log: () => {} });
  const session = await ptyManager.create({
    taskId: "smoke_task",
    routeId: "main",
    cwd: userdataDir,
  });
  session.write(process.platform === "win32" ? "echo smoke-pty-ok\r" : "echo smoke-pty-ok\n");
  const output = await session.output(750);
  if (!output.includes("smoke-pty-ok")) {
    fail(`pty output missing marker: ${JSON.stringify(output.slice(0, 400))}`);
  }
  await ptyManager.disposeAll();
  console.log("PKG_SMOKE pty ok");

  // -- 2. the task lock pair through a REAL command-service mutation -------
  const storageDir = path.join(userdataDir, "task-storage");
  const workspace = path.join(userdataDir, "smoke-workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "seed.txt"), "seed\n");
  const runtime = await createTaskCliRuntime({
    storageDir,
    agentWriter: async (task) => {
      fs.writeFileSync(path.join(task.workspaceRoot, "seed.txt"), "seed\nagent change\n");
    },
  });
  const cli = createTaskCliAdapter({ taskRuntime: runtime, output: collectStructuredOutput() });
  const task = await cli.start({ workspaceRoot: workspace, mode: "baseline" });
  const hunks = await cli.listHunks(task.taskId, task.activeRouteId);
  for (const hunk of hunks) {
    await cli.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: hunk.ref, status: "accepted" });
  }
  await cli.complete({ taskId: task.taskId, confirmValidationFailure: false });
  console.log("PKG_SMOKE task ok");

  // -- 3. lease residue: both lock files are removed on release — any
  //        survivor is a leak (re-verified from the test AFTER exit) -------
  const lockFiles = collectLockFiles(path.join(storageDir, "locks"));
  console.log(`PKG_SMOKE lockfiles ${lockFiles.length}`);
  if (lockFiles.length > 0) {
    fail(`lock lease files leaked: ${lockFiles.join(", ")}`);
  }
  console.log("PKG_SMOKE done");
}

// argv + userData redirect (Electron mode only — before the app is ready).
const userdataArg = process.argv.find((arg) => arg.startsWith("--smoke-user-data="));
const userdataDir = userdataArg?.slice("--smoke-user-data=".length) ?? "";
if (userdataDir === "" || !fs.existsSync(userdataDir)) {
  console.log("PKG_SMOKE fail missing/absent --smoke-user-data=<dir>");
  process.exit(1);
}

const app = loadElectronApp();
const timeout = setTimeout(() => fail(`timed out after ${SMOKE_TIMEOUT_MS}ms`), SMOKE_TIMEOUT_MS);
if (app === null) {
  // ELECTRON_RUN_AS_NODE (packaged smoke): no Electron lifecycle to honor.
  main(userdataDir)
    .then(() => {
      clearTimeout(timeout);
      process.exit(0);
    })
    .catch((error) => {
      clearTimeout(timeout);
      console.log(`PKG_SMOKE fail ${String(error)}`);
      process.exit(1);
    });
} else {
  app.setPath("userData", userdataDir);
  app
    .whenReady()
    .then(async () => {
      await main(userdataDir);
      clearTimeout(timeout);
      app.exit(0);
    })
    .catch((error) => {
      clearTimeout(timeout);
      console.log(`PKG_SMOKE fail ${String(error)}`);
      app.exit(1);
    });
}
