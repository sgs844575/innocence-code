// @innocencecode/terminal-pty — route-bound pseudo-terminal sessions.
// Host-agnostic: node-pty only, no Electron/DOM surface. The manager keys
// sessions by taskId+routeId; every event carries the identity triple.
export type {
  PtyExitEvent,
  PtyOutputEvent,
  PtySession,
  PtyEvent,
} from "./pty";
export { LivePtySession } from "./pty";
export { createPtyManager, type PtyManager, type PtyManagerOptions } from "./manager";
