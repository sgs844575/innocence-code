// 插件渲染层注册面 v1（PluginClientApi）：仅描述符式工具卡注册——client
// 模块零 import 铁律由描述符方案保证（注册载荷是纯数据，宿主侧
// DescriptorToolCard 统一渲染；组件级注册延后阶段 2）。命令式注册经键控
// 槽位的 subscribe 通道驱动消费组件重渲染（T2 语义）；生命周期由装载器
// 经 dispose 持有（同注册表重装载先撤销旧注册）。
import type { ComponentType } from "react";
import type { SlotRegistry } from "../slots/registry";
import {
  createDescriptorCard,
  type ToolCardDescriptor,
} from "../components/chat/toolcards/DescriptorToolCard";
import type { ToolCardProps } from "../components/chat/toolcards/registry";

/** v1 client API：前缀注册即 "prefix:" 声明条目（键控槽位原生语义）。 */
export interface PluginClientApi {
  registerToolCard(toolName: string, descriptor: ToolCardDescriptor): void;
  registerToolCardPrefix(prefix: string, descriptor: ToolCardDescriptor): void;
}

/** 工厂产物：api 交 client 模块的 default 注册函数；dispose 撤销该 api
 *  产生的全部注册（重复调用幂等，dispose 后再注册为无害空操作）。 */
export interface PluginClientApiHandle {
  readonly api: PluginClientApi;
  dispose(): void;
}

/** 构造注册面：描述符 → DescriptorToolCard 包装组件 → 键控槽位贡献。 */
export function createPluginClientApi(
  registry: SlotRegistry,
  slotName: string,
): PluginClientApiHandle {
  const slot = registry.keyed<ComponentType<ToolCardProps>>(slotName);
  const unregisters: Array<() => void> = [];
  let disposed = false;
  const register = (key: string, descriptor: ToolCardDescriptor): void => {
    if (disposed) return;
    unregisters.push(slot.register({ key, value: createDescriptorCard(descriptor) }));
  };
  return {
    api: {
      registerToolCard: (toolName, descriptor) => register(toolName, descriptor),
      registerToolCardPrefix: (prefix, descriptor) => register(`prefix:${prefix}`, descriptor),
    },
    dispose() {
      disposed = true;
      for (const off of unregisters.splice(0)) off();
    },
  };
}
