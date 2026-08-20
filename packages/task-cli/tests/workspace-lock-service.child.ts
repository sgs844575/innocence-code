// Real child-process helper for the workspace-lock competition test: holds
// the SAME cross-process lease pair (task lease → workspace lease over the
// same lock files) every command-service mutation acquires, so the parent's
// service mutations contend with this process exactly like a second host.
// Speaks the JSON-line protocol over stdio; Node runs it with type stripping.
//
// Protocol (one JSON object per line):
//   -> {"cmd":"hold"}     acquire task lease then workspace lease, reply {"event":"held"}
//   -> {"cmd":"release"}  dispose both leases, reply {"event":"released"}
//   -> {"cmd":"exit"}     release everything and exit 0
// Parent args: <storageDir> <taskId> <routeId> <canonicalWorkspaceKey>
import { openSecureStorage } from "@innocencecode/secure-storage-node";
// relative deep imports: Node type stripping needs fully-specified
// specifiers and the package barrels re-export extension-less (bundler
// resolution), while "exports" blocks package subpaths
import { createTaskMutationLock } from "../../task-workspace/src/task-mutation-lock.ts";
import { createWorkspaceWriteLock } from "../../task-workspace/src/workspace-lock.ts";

const [storageDir, taskId, routeId, workspaceKey] = process.argv.slice(2) as [string, string, string, string];

function write(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ pid: process.pid, ...event })}\n`);
}

async function main(): Promise<void> {
  const storage = await openSecureStorage(storageDir, {
    dirs: ["locks", "locks/workspace", "locks/task"],
  });
  const owner = { taskId, routeId };
  let held: AsyncDisposable[] = [];

  write({ event: "ready" });

  for await (const line of process.stdin) {
    let command: { cmd?: string };
    try {
      command = JSON.parse(String(line).trim()) as { cmd?: string };
    } catch {
      continue;
    }
    if (command.cmd === "hold") {
      // fixed order: task lease first, workspace lease second — the same
      // pair and lock files every command-service mutation acquires
      try {
        const taskLease = await createTaskMutationLock(storage).acquire(taskId, owner);
        try {
          const workspaceLease = await createWorkspaceWriteLock(storage).acquire(workspaceKey, owner);
          held = [workspaceLease, taskLease];
          write({ event: "held" });
        } catch (error) {
          await taskLease[Symbol.asyncDispose]();
          write({ event: "error", message: String(error) });
        }
      } catch (error) {
        write({ event: "error", message: String(error) });
      }
    } else if (command.cmd === "release") {
      for (const lease of held.splice(0)) {
        await lease[Symbol.asyncDispose]();
      }
      write({ event: "released" });
    } else if (command.cmd === "exit") {
      for (const lease of held.splice(0)) {
        await lease[Symbol.asyncDispose]();
      }
      process.exit(0);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
