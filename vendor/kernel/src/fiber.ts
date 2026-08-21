import type { Context } from "./context";
import { KernelError } from "./errors";
import { emitUnwindErrors, unwindRecords } from "./unwind";

/**
 * Lifecycle phases of one plugin fiber.
 *
 * `PENDING` — created but its entry has not started yet; `LOADING` — the
 * entry is running; `ACTIVE` — the entry finished and the fiber provides;
 * `FAILED` — the entry threw (the fiber stays until disposed); `UNLOADING`
 * — cleanup disposers are running; `DISPOSED` — detached and terminal.
 *
 * Declared as a runtime const object (not a `const enum`) so the values
 * survive cross-package single-file emit.
 */
export const FiberState = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const;

/** One lifecycle phase value of {@link FiberState}. */
export type FiberStateValue = (typeof FiberState)[keyof typeof FiberState];

/** Cleanup callback produced by an effect; may settle asynchronously. */
export type Disposer = () => void | Promise<void>;

/** Effect body: runs immediately and may return a {@link Disposer}. */
export type EffectBody = () => Disposer | void;

/** Handle returned by `ctx.effect()`; calling it tears the effect down. */
export type EffectHandle = () => void | Promise<void>;

/** What a plugin entry may hand back when it starts. */
export type StartupResult = Disposer | void | Promise<Disposer | void>;

/** Diagnostic metadata exposed through `fiber.getEffects()`. */
export interface EffectMeta {
  /** Human-readable label assigned at registration. */
  label: string;
  /** Effects nested below this one (reserved for future use). */
  children: EffectMeta[];
}

/** Internal bookkeeping for one registered effect. */
interface EffectRecord {
  meta: EffectMeta;
  disposer?: Disposer;
  /** Set once the disposer has run, so it never runs twice. */
  executed?: boolean;
}

/** Entry callback signature shared by every supported plugin shape. */
export type PluginCallback = (ctx: Context) => StartupResult;

/** Executable plugin entry driven by exactly one fiber. */
export interface PluginEntry {
  name?: string;
  callback: PluginCallback;
}

/** Initialization for the root fiber of a context tree. */
export interface RootFiberInit {
  root: Context;
}

/** Initialization for a fiber that runs one plugin below a parent. */
export interface PluginFiberInit {
  uid: number;
  parent: Fiber;
  entry: PluginEntry;
  /** Factory for the plugin-scoped context bound to this fiber. */
  context: (fiber: Fiber) => Context;
  /** Registry hook fired once, when the fiber detaches. */
  onDetach: () => void;
}

export type FiberInit = RootFiberInit | PluginFiberInit;

/**
 * One plugin runtime instance: a small state machine that owns effects.
 *
 * A fiber runs its plugin entry asynchronously after creation, collects
 * the effects the entry registers, and unwinds them in reverse order when
 * the fiber is disposed. Lifecycle work is serialized per fiber, so a
 * second `dispose()` while an unwind is running joins that same unwind
 * instead of racing a parallel one.
 */
export class Fiber {
  /** Current lifecycle state. */
  state: FiberStateValue = FiberState.PENDING;
  /** Registry identity; `0` for the root fiber, `null` once detached. */
  uid: number | null;
  /**
   * Errors raised by cleanup disposers during the latest unwind, in the
   * order they occurred; reset to an empty array when an unwind starts.
   */
  unwindErrors: readonly unknown[] = [];
  /** Owning fiber of the plugin that created this one; `null` for root. */
  readonly parent: Fiber | null;
  /** Context this fiber runs in (plugin-scoped, or the root context). */
  readonly ctx: Context;
  /** Unwind this fiber; settles only after cleanup finished. */
  readonly dispose: () => Promise<void>;
  /** Unwind, then run the entry again with the same context. */
  readonly restart: () => Promise<void>;
  /** Wait for pending lifecycle work; rethrows the startup error, if any. */
  readonly await: () => Promise<Fiber>;

  private readonly entry: PluginEntry | null;
  private readonly onDetach: (() => void) | null;
  private readonly records: EffectRecord[] = [];
  private detachLink: (() => void) | null = null;
  private settledDispose: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failure: { reason: unknown } | undefined;

  constructor(init: FiberInit) {
    const self = this;

    this.await = async () => {
      await self.chain;
      if (self.failure) throw self.failure.reason;
      return self;
    };

    this.restart = async () => {
      if (self.uid === null) throw new KernelError("INACTIVE_EFFECT");
      await self.enqueue(async () => {
        await self.unwind();
        await self.load();
      });
    };

    if ("root" in init) {
      this.uid = 0;
      this.ctx = init.root;
      this.parent = null;
      this.entry = null;
      this.onDetach = null;
      this.state = FiberState.ACTIVE;
      // Disposing the root scope empties it and returns it to a fresh,
      // active state, so repeated disposal is a no-op.
      this.dispose = () => self.restart();
      return;
    }

    this.uid = init.uid;
    this.parent = init.parent;
    this.entry = init.entry;
    this.onDetach = init.onDetach;
    this.ctx = init.context(self);
    this.attachToParent(init);
    this.dispose = () => {
      if (self.settledDispose) return self.settledDispose;
      self.detach();
      self.settledDispose = self.enqueue(async () => {
        await self.unwind();
        self.state = FiberState.DISPOSED;
      });
      return self.settledDispose;
    };
    // Never run plugin code synchronously inside ctx.plugin(): queue the
    // first load so callers always observe the fiber before its entry.
    void this.enqueue(() => self.load());
  }

  /** Create the root fiber owning `ctx`; it starts active and empty. */
  static createRoot(ctx: Context): Fiber {
    return new Fiber({ root: ctx });
  }

  /** Metadata for the effects currently registered on this fiber. */
  getEffects(): EffectMeta[] {
    return this.records.map((record) => record.meta);
  }

  /** Reject effect registration once the fiber is detached or unloading. */
  assertRegistrable(): void {
    if (this.uid === null || this.state === FiberState.UNLOADING) {
      throw new KernelError("INACTIVE_EFFECT");
    }
  }

  /**
   * Run `body` immediately and adopt the disposer it returns (if any).
   *
   * The disposer runs — exactly once — when the returned handle is called
   * or when this fiber unwinds, whichever happens first.
   *
   * @param body — effect body; a returned function becomes the disposer.
   * @param label — label shown in `getEffects()` diagnostics.
   * @returns a handle that unregisters and runs the disposer.
   * @throws {KernelError} `INACTIVE_EFFECT` when the fiber is detached or
   * already unloading.
   */
  effect(body: EffectBody, label?: string): EffectHandle {
    this.assertRegistrable();
    const record: EffectRecord = { meta: { label: label ?? "effect", children: [] } };
    const produced = body();
    if (typeof produced === "function") record.disposer = produced;
    const records = this.records;
    records.push(record);
    let live = true;
    return () => {
      if (!live || record.executed) return;
      live = false;
      removeItem(records, record);
      record.executed = true;
      return record.disposer?.();
    };
  }

  /** Register the parent-side record that disposes this fiber on unload. */
  private attachToParent(init: PluginFiberInit): void {
    init.parent.assertRegistrable();
    const link: EffectRecord = {
      meta: { label: `plugin(${init.entry.name ?? "anonymous"})`, children: [] },
      disposer: () => {
        this.detach();
        return this.dispose();
      },
    };
    init.parent.records.push(link);
    this.detachLink = () => removeItem(init.parent.records, link);
  }

  /** Detach from the parent and the registry; synchronous and idempotent. */
  private detach(): void {
    if (this.uid === null) return;
    this.uid = null;
    this.detachLink?.();
    this.detachLink = null;
    this.onDetach?.();
  }

  /**
   * Serialize a lifecycle step against every other step of this fiber.
   * Callers that arrive while work is in flight join behind it, which is
   * what merges concurrent disposals into a single unwind.
   */
  private enqueue(step: () => Promise<void>): Promise<void> {
    const run = this.chain.then(step);
    this.chain = run.then(noop, noop);
    return run;
  }

  /** Run the plugin entry, settling the fiber in ACTIVE or FAILED. */
  private async load(): Promise<void> {
    await Promise.resolve();
    if (this.uid === null) return;
    this.state = FiberState.LOADING;
    try {
      if (this.entry) {
        const produced = this.entry.callback(this.ctx);
        const settled = isThenable(produced) ? await produced : produced;
        if (this.uid === null) return;
        if (typeof settled === "function") {
          this.records.push({ meta: { label: "startup", children: [] }, disposer: settled });
        }
      }
      this.failure = undefined;
      this.state = FiberState.ACTIVE;
    } catch (reason) {
      this.failure = { reason };
      this.state = FiberState.FAILED;
    }
  }

  /**
   * Run every registered disposer in reverse registration order.
   *
   * Disposer failures are collected on `unwindErrors` and reported once
   * cleanup finished; the reported `fiberId` is the registry identity at
   * report time — `null` for disposal-triggered unwinds (the fiber
   * detaches before cleanup starts), the live id for in-place restarts.
   */
  private async unwind(): Promise<void> {
    this.state = FiberState.UNLOADING;
    const errors: unknown[] = [];
    this.unwindErrors = errors;
    const drained = this.records.splice(0);
    await unwindRecords(drained, errors);
    if (errors.length > 0) {
      emitUnwindErrors(this.ctx, { fiberId: this.uid, label: this.entry?.name, errors });
    }
    if (this.uid === null) this.state = FiberState.DISPOSED;
  }
}

/**
 * Wrap a fiber so `await` settles once its startup settles — resolving to
 * the fiber, or rejecting with its startup error. The fiber itself stays
 * non-thenable, so kernel code can hold it safely.
 */
export function toAwaitable(fiber: Fiber): Fiber & PromiseLike<Fiber> {
  const awaitable = Object.create(fiber) as Fiber & PromiseLike<Fiber>;
  awaitable.then = (onFulfilled, onRejected) => fiber.await().then(onFulfilled, onRejected);
  return awaitable;
}

function noop(): void {
  // Swallows step results so the serialization chain never rejects.
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as PromiseLike<unknown>).then === "function";
}

function removeItem<T>(list: T[], item: T): void {
  const index = list.indexOf(item);
  if (index >= 0) list.splice(index, 1);
}
