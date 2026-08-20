// PtyManager — the registry of route-bound PTY sessions. One session per
// (taskId, routeId) pair; creating for an occupied pair replaces the old
// session (dispose first), so a stale renderer can never type into a shell
// that belongs to a different route cwd.
import { LivePtySession, type PtyEvent, type PtySession } from "./pty";

export interface PtyManagerOptions {
  /** Every output chunk and the final exit, each carrying the identity triple. */
  readonly onEvent?: (event: PtyEvent) => void;
  readonly log?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
}

export interface PtyManager {
  create(input: { taskId: string; routeId: string; cwd: string; cols?: number; rows?: number }): Promise<PtySession>;
  /** The live session for a task route, if any. */
  get(taskId: string, routeId: string): PtySession | undefined;
  disposeForRoute(taskId: string, routeId: string): Promise<void>;
  disposeAll(): Promise<void>;
}

let mintSeq = 0;
const mintPtyId = () => `pty_${Date.now().toString(36)}_${(mintSeq++).toString(36)}`;

const routeKey = (taskId: string, routeId: string) => `${taskId}::${routeId}`;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function sanitizeDimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 500
    ? value
    : fallback;
}

export function createPtyManager(options: PtyManagerOptions = {}): PtyManager {
  const log = options.log ?? (() => {});
  const sessions = new Map<string, LivePtySession>();

  const disposeForRoute = async (taskId: string, routeId: string): Promise<void> => {
    const key = routeKey(taskId, routeId);
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    await session.dispose().catch((error) =>
      log("warn", "pty dispose failed", `${taskId}/${routeId}: ${String(error)}`),
    );
  };

  return {
    async create(input) {
      if (!input.taskId || !input.routeId) {
        throw new Error("pty manager: create requires taskId and routeId");
      }
      // Same-route re-create replaces: the old shell never outlives its route.
      await disposeForRoute(input.taskId, input.routeId);
      const session = new LivePtySession(
        {
          ptyId: mintPtyId(),
          taskId: input.taskId,
          routeId: input.routeId,
          cwd: input.cwd,
          cols: sanitizeDimension(input.cols, DEFAULT_COLS),
          rows: sanitizeDimension(input.rows, DEFAULT_ROWS),
        },
        {
          onEvent: (event) => options.onEvent?.(event),
          onGone: () => {
            sessions.delete(routeKey(input.taskId, input.routeId));
          },
        },
      );
      sessions.set(routeKey(input.taskId, input.routeId), session);
      log("info", "pty created", `${input.taskId}/${input.routeId} -> ${session.ptyId}`);
      return session;
    },
    get: (taskId, routeId) => sessions.get(routeKey(taskId, routeId)),
    disposeForRoute,
    async disposeAll() {
      const pairs = [...sessions.values()].map((session) => [session.taskId, session.routeId] as const);
      await Promise.all(pairs.map(([taskId, routeId]) => disposeForRoute(taskId, routeId)));
    },
  };
}
