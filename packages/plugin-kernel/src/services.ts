import type { Context } from "./context";

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
   */
  publish(name: string, instance: unknown): () => void {
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
