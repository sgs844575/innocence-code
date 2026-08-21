import type { Events } from "./events";
import { EventBus } from "./events";
import { Fiber } from "./fiber";
import type { EffectBody, EffectHandle } from "./fiber";
import type { Plugin } from "./registry";
import { Registry } from "./registry";
import { ServiceTable } from "./services";

/**
 * Public surface of a kernel context. Declared as an interface so services
 * can augment `ctx` with typed members via declaration merging.
 */
export interface Context {
  /** Fiber that owns this context: the root, or one plugin runtime. */
  fiber: Fiber;
  /** Plugin runtime table shared across the whole context tree. */
  registry: Registry;
  /**
   * Base URL used to resolve relative config paths and module specifiers;
   * set by the host or the loader service.
   */
  baseUrl?: string;
  /** Register a listener owned by the current fiber. */
  on<K extends keyof Events>(name: K, listener: Events[K]): () => void;
  /** Deliver an event synchronously to its current listeners. */
  emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void;
  /** Register an effect on the current fiber (see `Fiber.effect`). */
  effect(body: EffectBody, label?: string): EffectHandle;
  /** Start a plugin below this context; returns its awaitable fiber. */
  plugin(entry: Plugin): Fiber & PromiseLike<Fiber>;
  /**
   * Publish a named service on the scope that owns this context's service
   * table — the root, or the innermost scope this context was derived from.
   * Derived scopes may publish the same name to shadow it without affecting
   * enclosing contexts.
   *
   * @returns an idempotent withdraw handle; publishers commonly return it
   * from their entry so the service disappears when its fiber unwinds.
   */
  provide(name: string, instance: unknown): () => void;
}

/**
 * Root dependency container of the plugin kernel.
 *
 * A context carries the fiber tree, the plugin registry, and the event bus.
 * Children derived with a fiber are plugin runtime contexts that shadow
 * `fiber` while sharing every other member with their parent. Children
 * derived without a fiber are scopes that additionally carry their own
 * service table, so services published on them shadow the parent's names.
 */
export class Context {
  fiber: Fiber;
  registry: Registry;
  readonly services: ServiceTable;
  private readonly bus: EventBus;

  /** Create an empty, active root context. */
  constructor() {
    this.bus = new EventBus();
    this.registry = new Registry();
    this.services = new ServiceTable(this);
    this.fiber = Fiber.createRoot(this);
  }

  provide(name: string, instance: unknown): () => void {
    return this.services.publish(name, instance);
  }

  on<K extends keyof Events>(name: K, listener: Events[K]): () => void {
    return this.bus.subscribe(this.fiber, name, listener);
  }

  emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void {
    this.bus.dispatch(name, args);
  }

  effect(body: EffectBody, label?: string): EffectHandle {
    return this.fiber.effect(body, label);
  }

  plugin(entry: Plugin): Fiber & PromiseLike<Fiber> {
    return this.registry.load(this, entry);
  }

  /**
   * Derive a child context below this one.
   *
   * With `fiber`, the child is a plugin runtime context: it shadows `fiber`
   * and shares every other member — including this context's service table
   * — with its parent. Without `fiber`, the child is an independent scope:
   * it keeps the parent's fiber and carries its own service table, so
   * services published on the child shadow the parent's names without
   * affecting the parent or sibling scopes.
   */
  derive(fiber?: Fiber): Context {
    const child = Object.create(this) as Context;
    if (fiber === undefined) {
      Object.defineProperty(child, "services", {
        value: new ServiceTable(child),
        writable: false,
        enumerable: true,
      });
      return child;
    }
    child.fiber = fiber;
    return child;
  }
}
