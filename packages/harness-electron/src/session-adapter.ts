// HarnessPluginAdapter: the only new abstraction face of the kernelized
// session. It maps the legacy HarnessPlugin registration surface onto the
// spine services published on the kernel context (through the session
// registry view, the single registration chokepoint), keeps the
// `[pluginName]` log prefix, and parks plugin.dispose() as a fiber effect so
// the kernel unwind runs it exactly once, in reverse activation order.
import type {} from "@innocencecode/kernel-logger";
import type { Context } from "@innocencecode/kernel";
import type { HarnessPlugin, PluginContext } from "./registry";
import type { SessionRegistryView } from "./session-registry-view";

/**
 * Adapts one {@link HarnessPlugin} to a kernel plugin. `apply` runs the
 * plugin's activate against an adapted PluginContext; a failed activation
 * fails the fiber (surfaced by awaiting it), and the plugin's dispose is
 * registered as an effect only AFTER a successful activation — a failing
 * plugin is never disposed, exactly like the legacy registry's activated
 * stack.
 */
export function adaptHarnessPlugin(plugin: HarnessPlugin, view: SessionRegistryView) {
  return {
    name: plugin.name,
    async apply(ctx: Context): Promise<void> {
      const pluginContext: PluginContext = {
        registerTool: view.registerTool,
        registerProvider: view.registerProvider,
        registerSkill: view.registerSkill,
        registerPolicyRule: view.registerPolicyRule,
        registerMessageProcessor: view.registerMessageProcessor,
        registerToolMiddleware: view.registerToolMiddleware,
        log: (level, msg, data) => ctx.logger.log(level, `[${plugin.name}] ${msg}`, data),
      };
      await plugin.activate(pluginContext);
      const dispose = plugin.dispose;
      if (dispose) {
        ctx.effect(() => () => dispose(), `dispose(${plugin.name})`);
      }
    },
  };
}
