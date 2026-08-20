// Electron ↔ CLI adapter parity (Task 13): the Electron command service
// (bridge-backed, src/main/taskCommandService) and the CLI adapter
// (@innocencecode/task-cli) expose the SAME command semantics because both
// only delegate to task-core's one TaskCommandService. This suite proves it
// over REAL storage: both adapters drive the SAME task — identical hunks,
// identical error codes (task/route/version/gate), and mutations from either
// side are visible to the other. The service-level contract itself lives in
// packages/task-core/tests/command-service-contract.test.ts (host-free).
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectStructuredOutput,
  createTaskCliAdapter,
  createTaskCliRuntime,
} from "@innocencecode/task-cli";
import { createTaskRuntimeBridge } from "./taskRuntimeBridge";
import { createTaskCommandService } from "./taskCommandService";

const execFileAsync = promisify(execFile);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return dir;
}

async function createGitFixture(files: Record<string, string>): Promise<string> {
  const root = await tempDir("ic-parity-git-");
  const git = (args: string[]) => execFileAsync("git", args, { cwd: root, windowsHide: true });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Parity Fixture"]);
  await git(["config", "user.email", "parity@example.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), content, "utf8");
  }
  await git(["add", "-A"]);
  await git(["commit", "-m", "fixture base"]);
  return root;
}

describe("Electron ↔ CLI command adapter parity", () => {
  it("exposes the same command surface and error semantics over the same task", async () => {
    const repo = await createGitFixture({ "a.txt": "committed\n", "b.txt": "committed b\n" });
    const storageDir = await tempDir("ic-parity-store-");

    const cliRuntime = await createTaskCliRuntime({
      storageDir,
      agentWriter: async (task) => {
        await fs.writeFile(path.join(task.workspaceRoot, "a.txt"), "committed\nagent change\n", "utf8");
        await fs.writeFile(path.join(task.workspaceRoot, "b.txt"), "committed b\nagent change b\n", "utf8");
      },
    });
    const cli = createTaskCliAdapter({ taskRuntime: cliRuntime, output: collectStructuredOutput() });

    const bridge = createTaskRuntimeBridge({
      taskStorageDir: storageDir,
      onTaskEvent: () => {},
    });
    cleanups.push(() => bridge.disposeAll());
    const electron = createTaskCommandService({ bridge, taskStorageDir: storageDir, onEvent: () => {} });

    const task = await cli.start({ workspaceRoot: repo, mode: "baseline" });

    // -- identical hunks through both adapters ------------------------------
    const cliHunks = await cli.listHunks(task.taskId, task.activeRouteId);
    const electronHunks = await electron.getHunks(task.taskId, task.activeRouteId);
    expect(electronHunks.map((hunk) => [hunk.ref, hunk.path, hunk.status])).toEqual(
      cliHunks.map((hunk) => [hunk.ref, hunk.path, hunk.status]),
    );
    expect(cliHunks).toHaveLength(2);

    // -- identical error codes ----------------------------------------------
    await expect(electron.getHunks("nope", "main")).rejects.toMatchObject({ code: "task-not-found" });
    await expect(cli.listHunks("nope", "main")).rejects.toMatchObject({ code: "task-not-found" });
    await expect(electron.getHunks(task.taskId, "ghost")).rejects.toMatchObject({ code: "route-not-found" });
    await expect(cli.listHunks(task.taskId, "ghost")).rejects.toMatchObject({ code: "route-not-found" });

    const staleVersion = "v0:stale";
    await expect(
      electron.reviewHunk(task.taskId, task.activeRouteId, cliHunks[0]!.ref, "accepted", staleVersion),
    ).rejects.toMatchObject({ code: "version-conflict" });
    await expect(
      cli.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: cliHunks[0]!.ref, status: "accepted", expectedVersion: staleVersion }),
    ).rejects.toMatchObject({ code: "version-conflict" });

    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: false }))
      .rejects.toMatchObject({ code: "completion-gate" });

    // -- mutations through one adapter are visible through the other --------
    await cli.review({ taskId: task.taskId, routeId: task.activeRouteId, hunkRef: cliHunks[0]!.ref, status: "accepted" });
    await electron.reviewHunk(task.taskId, task.activeRouteId, cliHunks[1]!.ref, "accepted");

    const afterCliReview = await cli.listHunks(task.taskId, task.activeRouteId);
    const afterElectronReview = await electron.getHunks(task.taskId, task.activeRouteId);
    expect(afterCliReview.every((hunk) => hunk.status === "accepted")).toBe(true);
    expect(afterElectronReview.every((hunk) => hunk.status === "accepted")).toBe(true);

    await expect(cli.complete({ taskId: task.taskId, confirmValidationFailure: false })).resolves.toBeUndefined();
    // Electron sees the same completed review set and applies the same way
    const applied = await electron.applyAccepted(task.taskId, task.activeRouteId);
    expect(applied.conflicts).toEqual([]);
    expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toBe("committed\nagent change\n");
  }, 120_000);
});
