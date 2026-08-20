// TerminalPanel — the route-bound terminal surface (Task 9). Consumes ONLY
// typed terminal events through the injected api (never ipcRenderer). Task 11
// docks this component into the workbench bottom; it is self-contained:
//   - auto-creates one terminal per active route (never reuses an old-route
//     PTY for a new cwd — old ones are flagged 旧路线 and close-only),
//   - mounts one xterm.js frontend per PTY (scrollback survives tab switches),
//   - feeds keystrokes back as typed write DTOs, resizes via addon-fit.
import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, SquareTerminal, X } from "lucide-react";
import type { TerminalIpcApi } from "../../../../shared/terminalIpc";
import {
  addTerminal,
  emptyTerminalState,
  markStaleRoutes,
  markTerminalExited,
  removeTerminal,
  setActiveTerminal,
  type TerminalCollectionState,
  type TerminalEntryState,
  type TerminalRouteRef,
} from "./terminalState";

export interface TerminalPanelProps {
  /** Typed terminal bridge (preload implements the same shape). */
  api: TerminalIpcApi;
  /** The active task route; switching it flags other terminals as 旧路线. */
  activeTask: TerminalRouteRef | null;
  /** Panel collapse hook (the workbench owns open/close state). */
  onClose?: () => void;
}

/** Proposes dimensions without throwing when the host is not measurable. */
function safeDimensions(fit: FitAddon): { cols: number; rows: number } | null {
  try {
    const dims = fit.proposeDimensions();
    if (dims && dims.cols > 1 && dims.rows > 1) return { cols: dims.cols, rows: dims.rows };
  } catch {
    // jsdom / hidden containers have no layout — nothing to resize to.
  }
  return null;
}

interface TerminalViewProps {
  readonly entry: TerminalEntryState;
  readonly visible: boolean;
  onInput(ptyId: string, data: string): void;
  onFit(ptyId: string, cols: number, rows: number): void;
  register(ptyId: string, term: Terminal): void;
  unregister(ptyId: string): void;
}

/** One xterm.js frontend for one PTY. Kept mounted while the tab exists. */
function TerminalView({ entry, visible, onInput, onFit, register, unregister }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Latest-callback refs: the mount effect runs once per ptyId and must not
  // capture render-scoped closures.
  const callbacks = useRef({ onInput, onFit });
  callbacks.current = { onInput, onFit };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "Consolas, 'Courier New', monospace",
      cursorBlink: true,
      scrollback: 2000,
      convertEol: false,
      theme: { background: "#1b1d21" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    register(entry.ptyId, term);

    const dataSub = term.onData((data) => callbacks.current.onInput(entry.ptyId, data));

    const dims = safeDimensions(fit);
    if (dims) {
      term.resize(dims.cols, dims.rows);
      callbacks.current.onFit(entry.ptyId, dims.cols, dims.rows);
    }

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      let lastCols = dims?.cols ?? 0;
      let lastRows = dims?.rows ?? 0;
      observer = new ResizeObserver(() => {
        const next = safeDimensions(fit);
        if (next && (next.cols !== lastCols || next.rows !== lastRows)) {
          lastCols = next.cols;
          lastRows = next.rows;
          term.resize(next.cols, next.rows);
          callbacks.current.onFit(entry.ptyId, next.cols, next.rows);
        }
      });
      observer.observe(host);
    }

    return () => {
      observer?.disconnect();
      dataSub.dispose();
      unregister(entry.ptyId);
      term.dispose();
    };
    // Identity fields never change for a ptyId; callbacks go through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.ptyId, register, unregister]);

  return <div ref={hostRef} className={visible ? "absolute inset-0" : "hidden"} />;
}

export function TerminalPanel({ api, activeTask, onClose }: TerminalPanelProps): React.JSX.Element {
  const [collection, setCollection] = useState<TerminalCollectionState>(emptyTerminalState);
  const [createError, setCreateError] = useState<string | null>(null);

  // xterm frontends + output that arrived before a frontend mounted.
  const termsRef = useRef(new Map<string, Terminal>());
  const pendingRef = useRef(new Map<string, string>());
  const inflightRef = useRef(new Set<string>());
  const activeRef = useRef(activeTask);
  activeRef.current = activeTask;
  // State read through a ref: the auto-create check must run on route/api
  // changes only — an exit event (collection change) must NOT spawn a new
  // shell for the same route.
  const collectionRef = useRef(collection);
  collectionRef.current = collection;

  const register = useCallback((ptyId: string, term: Terminal) => {
    termsRef.current.set(ptyId, term);
    const buffered = pendingRef.current.get(ptyId);
    if (buffered !== undefined) {
      pendingRef.current.delete(ptyId);
      term.write(buffered);
    }
  }, []);
  const unregister = useCallback((ptyId: string) => {
    termsRef.current.delete(ptyId);
  }, []);

  // Typed event subscriptions — exactly once for the panel's lifetime.
  useEffect(() => {
    const offOutput = api.onTerminalOutput((event) => {
      const term = termsRef.current.get(event.ptyId);
      if (term) term.write(event.data);
      else {
        // Frontend not mounted yet (create raced the render) — buffer.
        pendingRef.current.set(event.ptyId, (pendingRef.current.get(event.ptyId) ?? "") + event.data);
      }
    });
    const offExit = api.onTerminalExit((event) => {
      setCollection((prev) => markTerminalExited(prev, event.ptyId, event.exitCode));
    });
    return () => {
      offOutput();
      offExit();
    };
  }, [api]);

  // Route switch: recompute 旧路线 flags (never reuses old PTYs for new cwds).
  useEffect(() => {
    setCollection((prev) => markStaleRoutes(prev, activeTask));
  }, [activeTask]);

  // UNMOUNT SEMANTICS (explicit decision, final review C2 — the Task 9
  // deferred question): the panel OWNS its terminals' lifecycle. The shell
  // keeps the panel mounted across TAB switches (xterm scrollback survives),
  // but a PANEL CLOSE unmounts it — every live (non-exited) terminal is then
  // disposed through the bridge so no shell trees leak in main. Keep-alive
  // across closes is rejected: the renderer state is gone, so re-opening
  // would spawn new terminals while the old PTYs stayed alive forever.
  useEffect(() => () => {
    for (const entry of Object.values(collectionRef.current.entries)) {
      if (entry.exited) continue;
      void api.dispose({ taskId: entry.taskId, routeId: entry.routeId, ptyId: entry.ptyId }).catch(
        () => undefined,
      );
    }
  }, [api]);

  // Auto-create a terminal for the active route when none is live.
  useEffect(() => {
    if (!activeTask) return;
    const route = activeTask;
    const key = `${route.taskId}::${route.routeId}`;
    if (inflightRef.current.has(key)) return;
    const current = collectionRef.current;
    const exists = current.order.some((id) => {
      const entry = current.entries[id];
      return (
        entry &&
        entry.taskId === route.taskId &&
        entry.routeId === route.routeId &&
        !entry.exited
      );
    });
    if (exists) return;
    inflightRef.current.add(key);
    api
      .create({ taskId: route.taskId, routeId: route.routeId })
      .then((created) => {
        setCollection((prev) => addTerminal(prev, created, activeRef.current));
        setCreateError(null);
      })
      .catch((error) => {
        setCreateError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        inflightRef.current.delete(key);
      });
  }, [api, activeTask]);

  const handleInput = useCallback(
    (ptyId: string, data: string) => {
      const entry = collection.entries[ptyId];
      if (!entry || entry.exited) return;
      void api.write({ taskId: entry.taskId, routeId: entry.routeId, ptyId, data });
    },
    [api, collection.entries],
  );

  const handleFit = useCallback(
    (ptyId: string, cols: number, rows: number) => {
      const entry = collection.entries[ptyId];
      if (!entry) return;
      void api.resize({ taskId: entry.taskId, routeId: entry.routeId, ptyId, cols, rows });
    },
    [api, collection.entries],
  );

  const closeTerminal = useCallback(
    (entry: TerminalEntryState) => {
      api
        .dispose({ taskId: entry.taskId, routeId: entry.routeId, ptyId: entry.ptyId })
        .catch(() => undefined)
        .finally(() => {
          setCollection((prev) => removeTerminal(prev, entry.ptyId));
        });
    },
    [api],
  );

  return (
    <section
      aria-label="终端面板"
      className="flex h-full min-h-0 flex-col border-t border-(--color-app-hairline) bg-(--color-app-bg)"
    >
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-(--color-app-hairline) px-2">
        <SquareTerminal size={14} className="shrink-0 text-(--color-app-muted)" />
        <div role="tablist" aria-label="终端标签" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {collection.order.map((ptyId) => {
            const entry = collection.entries[ptyId];
            const active = collection.activePtyId === ptyId;
            return (
              <div
                key={ptyId}
                role="tab"
                aria-selected={active}
                className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] ${
                  active ? "bg-(--color-app-bubble) text-(--color-app-text)" : "text-(--color-app-muted)"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setCollection((prev) => setActiveTerminal(prev, ptyId))}
                  className="flex items-center gap-1.5"
                >
                  <span className="font-mono">{entry.routeId}</span>
                  {entry.stale && (
                    <span className="rounded bg-(--color-app-accent) px-1 text-[10px] text-(--color-app-accent-fg)">
                      旧路线
                    </span>
                  )}
                  {entry.exited && (
                    <span className="rounded bg-(--color-app-bubble) px-1 text-[10px] text-(--color-app-muted)">
                      已退出
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={
                    entry.stale ? `关闭旧路线终端 ${entry.routeId}` : `关闭终端 ${entry.routeId}`
                  }
                  title="关闭终端"
                  onClick={() => closeTerminal(entry)}
                  className="grid size-5 place-items-center rounded text-(--color-app-muted) hover:bg-(--color-app-bubble)"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        {createError && (
          <span role="alert" className="max-w-[280px] truncate text-[11px] text-red-600">
            {createError}
          </span>
        )}
        <button
          type="button"
          aria-label="收起终端面板"
          title="收起终端面板"
          onClick={onClose}
          className="grid size-7 shrink-0 place-items-center rounded text-(--color-app-muted) hover:bg-(--color-app-bubble)"
        >
          <ChevronDown size={14} />
        </button>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden px-1 py-0.5">
        {collection.order.map((ptyId) => (
          <TerminalView
            key={ptyId}
            entry={collection.entries[ptyId]}
            visible={collection.activePtyId === ptyId}
            onInput={handleInput}
            onFit={handleFit}
            register={register}
            unregister={unregister}
          />
        ))}
      </div>
    </section>
  );
}
