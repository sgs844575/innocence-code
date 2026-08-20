// terminalState — pure state module for the terminal panel (Task 9). No
// xterm, no React, no IPC: fully testable in Node. The panel owns xterm
// instances and event subscriptions; this module only tracks WHICH
// terminals exist, which route is active, and which entries went stale
// (旧路线) or exited (已退出).
//
// Invariant: an entry is "stale" when its (taskId, routeId) pair is not the
// active route — a stale terminal is never reused for the new route's cwd;
// the user closes it explicitly.

export interface TerminalRouteRef {
  readonly taskId: string;
  readonly routeId: string;
}

export interface TerminalEntryState {
  readonly ptyId: string;
  readonly taskId: string;
  readonly routeId: string;
  /** 旧路线 — this route is no longer active; close-only, never reused. */
  readonly stale: boolean;
  /** The shell exited; the tab stays until the user closes it. */
  readonly exited: boolean;
  readonly exitCode: number | null;
}

export interface TerminalCollectionState {
  /** Insertion order of ptyIds (oldest first). */
  readonly order: readonly string[];
  readonly entries: Readonly<Record<string, TerminalEntryState>>;
  readonly activePtyId: string | null;
}

export const emptyTerminalState: TerminalCollectionState = {
  order: [],
  entries: {},
  activePtyId: null,
};

/** Stale = entry's route is not the active route (null active = all stale). */
export function terminalIsStale(
  entry: Pick<TerminalEntryState, "taskId" | "routeId">,
  active: TerminalRouteRef | null,
): boolean {
  if (!active) return true;
  return entry.taskId !== active.taskId || entry.routeId !== active.routeId;
}

export function addTerminal(
  state: TerminalCollectionState,
  created: TerminalRouteRef & { ptyId: string },
  active: TerminalRouteRef | null,
): TerminalCollectionState {
  if (state.entries[created.ptyId]) return state;
  const entry: TerminalEntryState = {
    ptyId: created.ptyId,
    taskId: created.taskId,
    routeId: created.routeId,
    stale: terminalIsStale(created, active),
    exited: false,
    exitCode: null,
  };
  return {
    order: [...state.order, created.ptyId],
    entries: { ...state.entries, [created.ptyId]: entry },
    activePtyId: created.ptyId,
  };
}

/** Recomputes staleness after the active route changed. */
export function markStaleRoutes(
  state: TerminalCollectionState,
  active: TerminalRouteRef | null,
): TerminalCollectionState {
  let changed = false;
  const entries: Record<string, TerminalEntryState> = {};
  for (const ptyId of state.order) {
    const entry = state.entries[ptyId];
    const stale = terminalIsStale(entry, active);
    if (stale !== entry.stale) changed = true;
    entries[ptyId] = stale === entry.stale ? entry : { ...entry, stale };
  }
  return changed ? { ...state, entries } : state;
}

export function markTerminalExited(
  state: TerminalCollectionState,
  ptyId: string,
  exitCode: number | null,
): TerminalCollectionState {
  const entry = state.entries[ptyId];
  if (!entry || entry.exited) return state;
  return {
    ...state,
    entries: { ...state.entries, [ptyId]: { ...entry, exited: true, exitCode } },
  };
}

/** Picks the next active terminal: newest live non-stale, else newest remaining. */
function nextActive(order: readonly string[], entries: Readonly<Record<string, TerminalEntryState>>): string | null {
  const ids = [...order].reverse();
  return ids.find((id) => !entries[id].stale && !entries[id].exited) ?? ids[0] ?? null;
}

export function removeTerminal(state: TerminalCollectionState, ptyId: string): TerminalCollectionState {
  if (!state.entries[ptyId]) return state;
  const entries = { ...state.entries };
  delete entries[ptyId];
  const order = state.order.filter((id) => id !== ptyId);
  return {
    order,
    entries,
    activePtyId: state.activePtyId === ptyId ? nextActive(order, entries) : state.activePtyId,
  };
}

export function setActiveTerminal(
  state: TerminalCollectionState,
  ptyId: string,
): TerminalCollectionState {
  if (!state.entries[ptyId] || state.activePtyId === ptyId) return state;
  return { ...state, activePtyId: ptyId };
}
