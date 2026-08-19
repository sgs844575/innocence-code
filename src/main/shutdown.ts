/**
 * Async-shutdown handshake for Electron's before-quit. The harness owns OS
 * resources (MCP child processes, in-flight builds, pending permission asks)
 * that must be released before the process exits, so the first quit attempt
 * is always preventDefault'ed while the release runs.
 *
 * The started/released split closes the release-window hole: a SECOND quit
 * attempt arriving while the release is still running (e.g. window-all-closed
 * firing app.quit() again) must ALSO be preventDefault'ed, or the process
 * would exit mid-disposeAllRuntime and leak the detached POSIX MCP process
 * group. Only after markReleased() does the gate let a quit through.
 */
export type ShutdownPhase = "start" | "hold" | "release";

export class ShutdownGate {
  private started = false;
  private released = false;

  /**
   * One call per before-quit event; a pure state transition — the caller owns
   * preventDefault and the release work.
   * - "start":   first attempt — caller preventDefaults and starts the release.
   * - "hold":    release already running and not finished — preventDefault again.
   * - "release": release finished — let this quit proceed untouched.
   */
  onBeforeQuit(): ShutdownPhase {
    if (this.released) return "release";
    if (this.started) return "hold";
    this.started = true;
    return "start";
  }

  /** Marks the release complete; every later before-quit passes through. */
  markReleased(): void {
    this.released = true;
  }
}
