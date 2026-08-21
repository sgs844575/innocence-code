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
   * Publish a named, tree-wide service on the root context.
   *
   * @returns an idempotent withdraw handle; publishers commonly return it
   * from their entry so the service disappears when its fiber unwinds.
   */
  provide(name: string, instance: unknown): () => void;
}

/**
 * Root dependency container of the plugin kernel.
 *
 * A context carries the fiber tree, the plugin registry, and the event
 * bus. Plugin-scoped contexts are derived children that shadow `fiber`
 * while sharing everything else with the root.
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
   * Create a plugin-scoped child context bound to `fiber`.
   *
   * The child inherits every member of this context and shadows only its
   * owning fiber; the parent is left untouched.
   */
  derive(fiber: Fiber): Context {
    const child = Object.create(this) as Context;
    child.fiber = fiber;
    return child;
  }
}
