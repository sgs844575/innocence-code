import type { Fiber } from "./fiber";

/**
 * Payload of the built-in unwind-error event.
 *
 * Delivered once per finished unwind, only when at least one cleanup
 * disposer threw.
 */
export interface UnwindErrorPayload {
  /** Registry identity at report time; `null` once the fiber detached. */
  fiberId: number | null;
  /** Display name of the plugin entry, when one was given. */
  label: string | undefined;
  /** Disposer failures of that unwind, in the order they occurred. */
  errors: unknown[];
}

/**
 * Typed event catalog of the kernel.
 *
 * Listeners are declared as call signatures, and consumer modules extend
 * the catalog through declaration merging:
 *
 * ```ts
 * declare module "@innocencecode/kernel" {
 *   interface Events {
 *     "my/event"(payload: string): void
 *   }
 * }
 * ```
 */
export interface Events {
  /** Aggregated cleanup failures of one fiber unwind (internal). */
  "internal/unwind-error"(payload: UnwindErrorPayload): void;
}

/** Listener shape stored internally, one array per event name. */
type Listener = (...args: any[]) => void;

/**
 * Synchronous event bus shared by one context tree.
 *
 * Every subscription is an effect of the fiber that registered it, so the
 * listener disappears when that fiber unloads — or earlier, when its
 * unsubscribe handle is called.
 */
export class EventBus {
  private readonly channels = new Map<string, Listener[]>();

  /**
   * Subscribe on behalf of `fiber`.
   *
   * @returns the unsubscribe handle; calling it removes the listener and
   * returns whatever removal settles with (nothing).
   */
  subscribe(fiber: Fiber, name: string, listener: Listener): () => void {
    return fiber.effect(() => {
      this.channel(name).push(listener);
      return () => {
        this.drop(name, listener);
      };
    }, `on(${name})`);
  }

  /**
   * Deliver one event synchronously to the listeners registered now.
   *
   * Listeners run in registration order over a snapshot of the channel, so
   * unsubscribing mid-dispatch cannot skip the remaining deliveries.
   */
  dispatch(name: string, args: readonly unknown[]): void {
    const listeners = this.channels.get(name);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      listener(...args);
    }
  }

  private channel(name: string): Listener[] {
    let listeners = this.channels.get(name);
    if (!listeners) {
      listeners = [];
      this.channels.set(name, listeners);
    }
    return listeners;
  }

  private drop(name: string, listener: Listener): void {
    const listeners = this.channels.get(name);
    if (!listeners) return;
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
    if (listeners.length === 0) this.channels.delete(name);
  }
}
