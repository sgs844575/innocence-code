// 插件渲染层模块装载器：清单投影（IPC plugins:list）中 client && active 的
// 条目经 innocence-plugin:// 协议动态 import，调用其 default 注册函数把
// 描述符式工具卡注册进槽位。失败隔离——单插件失败（导入拒绝/无 default/
// 注册抛出）只 console.warn 含插件 id，不阻断其余条目。同一注册表的重复
// 装载先撤销上一轮注册：清单随设置变化重放，停用条目的卡随之回落兜底。
import type { PluginInventoryEntry } from "../../../shared/ipc";
import type { SlotRegistry } from "../slots/registry";
import { TOOLCARD_SLOT } from "../components/chat/toolcards/registry";
import { createPluginClientApi, type PluginClientApi } from "./api";

/** 插件 client 模块形态：default 为宿主注入 api 的注册函数。 */
export interface PluginClientModule {
  default?: (api: PluginClientApi) => void | Promise<void>;
}

/** 动态模块导入端口（调用方注入：应用侧为协议 URL 全局 import；测试注入 mock）。 */
export type ImportModule = (url: string) => Promise<PluginClientModule>;

/**
 * 应用侧注入实现：变量 URL 的全局动态 import。忽略注释阻止打包器对变量
 * 说明符做静态分析/改写（等价于经 Function 构造器取全局 import 的形态，
 * 且不受生产 CSP 的 eval 限制——script-src 已放行插件协议）。
 */
export function importSchemeModule(url: string): Promise<PluginClientModule> {
  return import(/* @vite-ignore */ url);
}

export interface LoadPluginClientsOptions {
  /** 清单投影（App 层拉取；仅 client && active 条目参与装载）。 */
  inventory: PluginInventoryEntry[];
  /** 槽位注册表（与 <SlotProvider> 同一实例，命令式注册驱动订阅重渲染）。 */
  registry: SlotRegistry;
  /** 动态导入端口（注入式设计，避开打包器对变量 URL 的静态转译）。 */
  importModule: ImportModule;
}

/** 每个注册表当前的装载回合（App 生命期单注册表；按注册表隔离撤销集）。 */
const rounds = new WeakMap<SlotRegistry, ReturnType<typeof createPluginClientApi>>();

/** 协议布局与 staging 产物一致：plugins/<id>/dist/client.js。 */
export function clientModuleUrl(id: string): string {
  return `innocence-plugin://${id}/dist/client.js`;
}

export async function loadPluginClients(options: LoadPluginClientsOptions): Promise<void> {
  // 先撤销上一轮：本轮未再装载（停用/装载失败）的条目不再持有旧卡。
  const previous = rounds.get(options.registry);
  if (previous) {
    previous.dispose();
    rounds.delete(options.registry);
  }
  const candidates = options.inventory.filter((entry) => entry.client && entry.state === "active");
  if (candidates.length === 0) return;
  const handle = createPluginClientApi(options.registry, TOOLCARD_SLOT);
  rounds.set(options.registry, handle);
  for (const entry of candidates) {
    try {
      const mod = await options.importModule(clientModuleUrl(entry.id));
      const register = mod?.default;
      if (typeof register !== "function") {
        console.warn(`plugin client "${entry.id}" has no default register function; skipped`);
        continue;
      }
      await register(handle.api);
    } catch (err) {
      console.warn(`plugin client "${entry.id}" failed to load`, err);
    }
  }
}
