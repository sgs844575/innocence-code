import type { Context } from "./context";
import { KernelError } from "./errors";

/**
 * Named kernel services scoped to one owning context.
 *
 * A service is one instance published under a stable name by the plugin or
 * scope that owns it. Publishing installs a lazily-resolving accessor on the
 * owning context, so the owner — and every context derived from it —
 * observes the same live instance. A scope derived below the owner may
 * publish the same name to shadow it locally; withdrawing removes the
 * accessor and the table entry again.
 */
export class ServiceTable {
  private readonly instances = new Map<string, unknown>();

  constructor(private readonly owner: Context) {}

  /**
   * Publish `instance` under `name` on the owning context.
   *
   * The name becomes a property of the owning context, so it must not
   * collide with reserved context members; publishing a name that an
   * enclosing scope already published is legal and shadows it for this
   * scope only. Services are typed on `Context` through declaration merging
   * by their publisher.
   *
   * @returns an idempotent withdraw handle that unpublishes the service.
   * @throws {@link KernelError} `DUPLICATE_SERVICE` when `name` is already
   * published on this context, or `SERVICE_NAME_CONFLICT` when the name is
   * reserved by a context member of this scope or its prototype chain.
   */
  publish(name: string, instance: unknown): () => void {
    // A published name is also an own property of the owner, so check the
    // service table first to report duplicates with the precise guidance.
    if (this.instances.has(name)) {
      throw new KernelError(
        "DUPLICATE_SERVICE",
        `service "${name}" is already published; withdraw it before publishing again`,
      );
    }
    if (this.reserved(name)) {
      throw new KernelError(
        "SERVICE_NAME_CONFLICT",
        `cannot publish service "${name}": the name is reserved by an existing context member`,
      );
    }
    this.instances.set(name, instance);
    Object.defineProperty(this.owner, name, {
      configurable: true,
      get: () => this.instances.get(name),
    });
    let withdrawn = false;
    return () => {
      if (withdrawn) return;
      withdrawn = true;
      this.instances.delete(name);
      Reflect.deleteProperty(this.owner, name);
    };
  }

  /**
   * Look up the service bound to `name` on the owning context, then through
   * its prototype chain. Names bound to reserved members are not services
   * and resolve to `undefined`.
   */
  resolve<T = unknown>(name: string): T | undefined {
    for (let level: object | null = this.owner; level !== null; level = Object.getPrototypeOf(level)) {
      if (!Object.prototype.hasOwnProperty.call(level, name)) continue;
      return publishedOn(level, name) ? ((level as Record<string, unknown>)[name] as T) : undefined;
    }
    return undefined;
  }

  /** Whether the owning context published a service under `name` itself. */
  owns(name: string): boolean {
    return this.instances.has(name);
  }

  /**
   * Whether `name` is reserved against publication on the owning context:
   * bound as an own member of this context or of any context on its
   * prototype chain — including inherited function members such as `emit`,
   * `on`, `plugin`, or `derive` — unless the nearest binding is a service
   * published by an enclosing scope, which this scope may shadow.
   */
  private reserved(name: string): boolean {
    for (let level: object | null = this.owner; level !== null; level = Object.getPrototypeOf(level)) {
      if (!Object.prototype.hasOwnProperty.call(level, name)) continue;
      return !publishedOn(level, name);
    }
    return false;
  }
}

/**
 * Whether `level` is a context that published `name` itself. Publications
 * install own accessors on contexts that carry their own service table, so
 * a binding is shadowable exactly when its context owns it as a service.
 */
function publishedOn(level: object, name: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(level, "services")) return false;
  const services = (level as { services: ServiceTable }).services;
  return services instanceof ServiceTable && services.owns(name);
}
