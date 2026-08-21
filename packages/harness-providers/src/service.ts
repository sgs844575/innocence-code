import type { Context } from "@innocencecode/kernel";
import type { Provider } from "./provider";

// Services are typed on `Context` through declaration merging by their
// publisher (kernel ServiceTable contract). The member is live only while
// the ProvidersPlugin fiber publishing it is active; before load and after
// its unwind the property is absent at runtime.
declare module "@innocencecode/kernel" {
  interface Context {
    providers: ProvidersService;
  }
}

/** Providers registration surface published by {@link ProvidersPlugin} under "providers". */
export interface ProvidersService {
  /**
   * Registers a provider; duplicate ids are rejected (the provider
   * registration gate: a duplicate never overwrites the earlier entry).
   */
  register(provider: Provider): void;
  get(id: string): Provider | undefined;
  /** Registered provider ids in registration order. */
  ids(): string[];
}

/**
 * Providers spine service plugin. `apply` publishes a {@link ProvidersService}
 * under "providers" on the scope owning the plugin context and returns the
 * withdraw handle, so the service disappears when the plugin fiber unwinds.
 */
export const ProvidersPlugin: { name: "harness-providers"; apply(ctx: Context): () => void } = {
  name: "harness-providers",
  apply(ctx) {
    const registeredProviders = new Map<string, Provider>();

    const service: ProvidersService = {
      register: (provider) => {
        if (registeredProviders.has(provider.id)) {
          throw new Error(`duplicate provider registration: ${provider.id}`);
        }
        registeredProviders.set(provider.id, provider);
      },
      get: (id) => registeredProviders.get(id),
      ids: () => [...registeredProviders.keys()],
    };

    return ctx.provide("providers", service);
  },
};

/** Kernel provider plugin wrapping one concrete provider instance (name "provider"). */
export interface ProviderPlugin {
  readonly name: "provider";
  apply(ctx: Context): void;
}

/**
 * Wraps one provider instance as a kernel plugin. Host compositions that
 * build their provider from their own settings (profile, API keys...) use
 * this so every session's provider flows through the providers registry —
 * the single path the session kernel resolves from.
 */
export function createProviderPlugin(provider: Provider): ProviderPlugin {
  return {
    name: "provider",
    apply(ctx) {
      ctx.providers.register(provider);
    },
  };
}
