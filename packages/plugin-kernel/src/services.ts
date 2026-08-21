import type { Context } from "./context";
import { KernelError } from "./errors";

/**
 * Tree-wide table of named kernel services.
 *
 * A service is one instance published under a stable name by the plugin that
 * owns it. Publishing installs a lazily-resolving accessor on the ROOT
 * context, so every derived context of the tree observes the same live
 * instance, and withdrawing removes the accessor again.
 */
export class ServiceTable {
  private readonly instances = new Map<string, unknown>();

  constructor(private readonly root: Context) {}

  /**
   * Publish `instance` under `name` for the whole context tree.
   *
   * The name becomes a property of the root context, so it must not collide
   * with existing context members. Services are typed on `Context` through
   * declaration merging by their publisher.
   *
   * @returns an idempotent withdraw handle that unpublishes the service.
   * @throws {@link KernelError} `DUPLICATE_SERVICE` when `name` is already
   * published, or `SERVICE_NAME_CONFLICT` when it collides with an own
   * property of the context.
   */
  publish(name: string, instance: unknown): () => void {
    // A published name is also an own property of the root, so check the
    // service table first to report duplicates with the precise guidance.
    if (this.instances.has(name)) {
      throw new KernelError(
        "DUPLICATE_SERVICE",
        `service "${name}" is already published; withdraw it before publishing again`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(this.root, name)) {
      throw new KernelError(
        "SERVICE_NAME_CONFLICT",
        `cannot publish service "${name}": the name is reserved by an existing context member`,
      );
    }
    this.instances.set(name, instance);
    Object.defineProperty(this.root, name, {
      configurable: true,
      get: () => this.instances.get(name),
    });
    let withdrawn = false;
    return () => {
      if (withdrawn) return;
      withdrawn = true;
      this.instances.delete(name);
      Reflect.deleteProperty(this.root, name);
    };
  }

  /** Look up the service published under `name`, if any. */
  resolve<T = unknown>(name: string): T | undefined {
    return this.instances.get(name) as T | undefined;
  }
}
