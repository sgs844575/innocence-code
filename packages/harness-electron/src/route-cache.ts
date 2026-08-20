// Route-aware AgentSession cache: owns the keyed session table
// (`${sessionId}:${routeId}`), in-flight build deduplication and the
// dispose/build race state machine (tombstones, bounded waits). The runtime
// delegates cache mechanics here and keeps session construction and the
// streaming/persistence responsibilities (see runtime.ts).
import type { AgentSession } from "@innocencecode/harness-core";

/**
 * How long dispose() waits for an in-flight session build before giving up
 * (app quit must not hang on a stuck MCP spawn). The dispose tombstone
 * already guarantees the late build releases its own product, so expiry
 * only ends the wait — it never leaks on its own.
 */
export const IN_FLIGHT_BUILD_DISPOSE_TIMEOUT_MS = 10_000;

/** Cache key of one chat session's route: fixed `${sessionId}:${routeId}`. */
export function routeCacheKey(sessionId: string, routeId: string): string {
  return `${sessionId}:${routeId}`;
}

/** Chat session id prefix (incl. the ":") of every route key it owns. */
export function routeKeyPrefix(sessionId: string): string {
  return `${sessionId}:`;
}

/**
 * Fail-fast error for a turn targeting a cache key that dispose() owns
 * (in progress or timed out): its build is doomed, so the turn errors via
 * onError immediately instead of parking on a promise that never settles.
 */
export const sessionDisposedError = (key: string): Error =>
  new Error(`会话已释放（${key}），本轮已取消，请重建会话`);

export interface CachedRouteSession {
  /** Cache key (`${sessionId}:${routeId}`). */
  key: string;
  /** Settings hash the session was built under (rebuild signal). */
  settingsKey: string;
  session: AgentSession;
}

export interface RouteCacheCallbacks {
  /** Builds one route's AgentSession (the runtime's construction path). */
  build(key: string): Promise<AgentSession>;
  /** Disposes one session; never throws — failures are reported here. */
  settleDispose(key: string, session: AgentSession): Promise<void>;
  log(level: "info" | "warn" | "error", msg: string, data?: unknown): void;
}

export class RouteSessionCache {
  private readonly sessions = new Map<string, CachedRouteSession>();
  /** In-flight session builds, keyed by cache key (build dedup). */
  private readonly building = new Map<string, Promise<AgentSession>>();
  /** Cache keys whose dispose() arrived while a build was in flight. */
  private readonly disposing = new Set<string>();
  private readonly running = new Map<string, AbortController>();
  private readonly cb: RouteCacheCallbacks;

  constructor(callbacks: RouteCacheCallbacks) {
    this.cb = callbacks;
  }

  peek(key: string): CachedRouteSession | undefined {
    return this.sessions.get(key);
  }

  isDisposing(key: string): boolean {
    return this.disposing.has(key);
  }

  /** Registers the run controller of one key; one route runs one turn at a time. */
  startRun(key: string, controller: AbortController): void {
    this.running.set(key, controller);
  }

  endRun(key: string): void {
    this.running.delete(key);
  }

  abort(key: string): void {
    this.running.get(key)?.abort();
  }

  /** Aborts every running route of one chat session (user-level stop). */
  abortSession(sessionId: string): void {
    for (const key of this.running.keys()) {
      if (key.startsWith(routeKeyPrefix(sessionId))) this.abort(key);
    }
  }

  /**
   * Resolves the agent session for one cache key. Concurrent sends share a
   * single in-flight build: a dropped losing build would leak its plugins
   * (e.g. an MCP child-process tree nobody disposes). EXCEPTION: while
   * dispose() owns the key (including the post-timeout window, where the
   * stuck build never settles), joining that build would park the new turn
   * forever on a session that is already doomed — fail fast instead.
   */
  agentFor(key: string): Promise<AgentSession> {
    if (this.disposing.has(key)) {
      throw sessionDisposedError(key);
    }
    const inFlight = this.building.get(key);
    if (inFlight) return inFlight;

    const settled = this.cb.build(key).finally(() => {
      // Cleared on settle so failures never pin a rejected promise: a later
      // send retries the build instead of replaying the old outcome.
      if (this.building.get(key) === settled) {
        this.building.delete(key);
      }
    });
    this.building.set(key, settled);
    return settled;
  }

  /** Caches a freshly built session (the builder already copied any rebuild history). */
  commit(key: string, settingsKey: string, session: AgentSession): void {
    this.sessions.set(key, { key, settingsKey, session });
  }

  /** Releases a landing session in place — dispose() owns the key, so it must
   *  never enter the cache or run a turn. */
  async releaseInPlace(key: string, session: AgentSession): Promise<void> {
    await this.settleDispose(key, session);
  }

  /**
   * Releases one route's agent resources: aborts any active run, waits for
   * it to settle and disposes the session's plugins. Deleting a cache entry
   * alone is not resource cleanup. Never rejects — disposal failures are
   * reported through the log callback.
   *
   * A build can be in flight (its awaits span plugin factories and
   * AgentSession.create — MCP spawns take seconds): dispose then releases
   * the cached entry immediately, marks the key so the landing build
   * releases its own product instead of caching it, and waits for that to
   * happen — BOUNDED by IN_FLIGHT_BUILD_DISPOSE_TIMEOUT_MS so a hung spawn
   * cannot hang the quit path. A session built for a disposed key therefore
   * never leaks and its triggering send fails fast with 会话已释放.
   */
  async dispose(key: string): Promise<void> {
    const inFlight = this.building.get(key);
    if (!inFlight) {
      await this.releaseCached(key);
      return;
    }
    // Tombstone FIRST (synchronously): the build's landing check must see
    // it even if it races past this point while we release the old entry.
    this.disposing.add(key);
    await this.releaseCached(key);
    await this.waitBuildForDisposal(key, inFlight);
  }

  /** Releases every route of one chat session (chat-level delete). */
  async disposeSession(sessionId: string): Promise<void> {
    const prefix = routeKeyPrefix(sessionId);
    const keys = new Set<string>([...this.sessions.keys(), ...this.building.keys()]);
    for (const key of keys) {
      if (key.startsWith(prefix)) await this.dispose(key);
    }
  }

  /** Releases every cached agent session and every in-flight build (e.g. app shutdown). */
  async disposeAll(): Promise<void> {
    // In-flight builds first: dispose() makes each landing product release
    // itself instead of re-populating the cache after the sweep below.
    const building = [...this.building.keys()];
    await Promise.all(building.map((key) => this.dispose(key)));
    const entries = [...this.sessions];
    this.sessions.clear();
    await Promise.all(
      entries.map(([key, entry]) => this.settleDispose(key, entry.session)),
    );
  }

  private async releaseCached(key: string): Promise<void> {
    const cached = this.sessions.get(key);
    if (!cached) return;
    this.sessions.delete(key);
    await this.settleDispose(key, cached.session);
  }

  private async settleDispose(key: string, session: AgentSession): Promise<void> {
    await this.cb.settleDispose(key, session);
  }

  /**
   * Bounded wait for an in-flight build during dispose. Resolves when the
   * build settles (tombstone lifted here) or the bound expires (error logged;
   * the tombstone must then OUTLIVE this call — a late landing product must
   * still see it and self-release — so its removal is handed to the build's
   * landing). Never rejects.
   */
  private async waitBuildForDisposal(key: string, inFlight: Promise<AgentSession>): Promise<void> {
    let settleTombstone = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        inFlight,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            settleTombstone = false;
            this.cb.log("error", "dispose timed out waiting for in-flight build", key);
            // Lift the tombstone once the stuck build eventually lands (ok
            // or failed) so future sends can rebuild; until then it stays
            // visible and the landing product self-releases.
            const lift = () => this.disposing.delete(key);
            inFlight.then(lift, lift);
            resolve();
          }, IN_FLIGHT_BUILD_DISPOSE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // The build failed or was cancelled by this dispose — its product is
      // already released (or never existed); nothing more to clean up.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (settleTombstone) this.disposing.delete(key);
    }
  }
}
