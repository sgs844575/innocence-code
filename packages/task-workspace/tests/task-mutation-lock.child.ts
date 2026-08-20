/**
 * Real-OS-process helper for cross-process task-mutation-lock tests. NOT a
 * vitest file.
 *
 * Usage: node task-mutation-lock.child.ts <secureBaseDir>
 * Protocol: stdout JSON lines; stdin JSON line commands:
 *   {"cmd":"acquire","taskId":"...","ownerTaskId":"...","routeId":"..."}
 *     -> {"event":"acquired","pid":...} | {"event":"error","message":"..."}
 *   {"cmd":"release"} -> {"event":"released"}
 *   {"cmd":"exit"}    -> process exits 0
 */
import { openSecureStorage } from "@innocencecode/secure-storage-node";
import { createTaskMutationLock } from "../src/task-mutation-lock.ts";

const emit = (payload: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const storage = await openSecureStorage(process.argv[2] ?? ".", {
  dirs: ["locks", "locks/workspace", "locks/task"],
});
const lock = createTaskMutationLock(storage);
let handle: AsyncDisposable | null = null;
emit({ event: "ready", pid: process.pid });

async function dispatch(line: string): Promise<void> {
  let command: {
    cmd?: string;
    taskId?: string;
    ownerTaskId?: string;
    routeId?: string;
  };
  try {
    command = JSON.parse(line);
  } catch {
    emit({ event: "protocol-error" });
    return;
  }
  try {
    if (command.cmd === "acquire") {
      if (handle !== null) {
        emit({ event: "error", message: "already holding the lease" });
        return;
      }
      handle = await lock.acquire(command.taskId ?? "", {
        taskId: command.ownerTaskId ?? command.taskId ?? "",
        routeId: command.routeId ?? null,
      });
      emit({ event: "acquired", pid: process.pid });
      return;
    }
    if (command.cmd === "release") {
      const current = handle;
      handle = null;
      await current?.[Symbol.asyncDispose]();
      emit({ event: "released" });
      return;
    }
    if (command.cmd === "exit") {
      process.exit(0);
    }
    emit({ event: "protocol-error" });
  } catch (error) {
    emit({ event: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) {
      break;
    }
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      void dispatch(line);
    }
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});
