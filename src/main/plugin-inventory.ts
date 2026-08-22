// 插件清单投影（IPC plugins:list 的载荷来源）：manifest 描述符元数据 +
// resolvePluginSet 的当前解析 → 设置页插件节的数据形状。纯函数、无 IO、
// 无 Electron——被 pluginBoot/compose 的 boot 面聚合（每次调用重跑解析，
// 状态随 toggles 即时反映）。shared/ipc.ts 持有 DTO 的手工镜像（渲染层
// 无法 import main），修改任一侧时必须同步另一侧
// （packages/harness-electron/tests/mirror.test.ts 有 drift-guard）。
import type {
  PluginDescriptor,
  PluginToggleLayer,
  ResolvedPluginSet,
} from "./plugin-toggles-local";

/** 清单条目的运行时投影状态（active / 配置停用 / 依赖连带停用）。 */
export type PluginInventoryState = "active" | "disabled-by-config" | "dependency-disabled";

/** 设置页插件清单的一条投影：清单 id + 展示名 + core/client 标记 + 当前
 *  解析状态与停用获胜层（active 恒 default）。 */
export interface PluginInventoryEntry {
  id: string;
  /** 中性展示名（build:plugins 从包 description 投影；缺省回落 id）。 */
  title: string;
  /** 恒开（开关呈禁用态）。 */
  core: boolean;
  /** 是否带渲染层模块（构建后 dist/client.js 存在）。 */
  client: boolean;
  /** 按当前 toggles 现算的解析状态。 */
  state: PluginInventoryState;
  /** 停用获胜层（active 恒 default）。 */
  via: PluginToggleLayer;
}

export type PluginInventory = PluginInventoryEntry[];

/** manifest 描述符 + 解析结果 → 清单投影（跳过项带原因与获胜层，active
 *  项 via 恒 default；title 缺省回落 id——旧 manifest 兼容）。 */
export function projectPluginInventory(
  descriptors: readonly PluginDescriptor[],
  resolved: ResolvedPluginSet,
): PluginInventory {
  const skipped = new Map(resolved.skipped.map((entry) => [entry.id, entry]));
  return descriptors.map((descriptor) => {
    const skip = skipped.get(descriptor.id);
    return {
      id: descriptor.id,
      title: descriptor.title ?? descriptor.id,
      core: descriptor.core === true,
      client: descriptor.client === true,
      state: skip?.reason ?? "active",
      via: skip?.via ?? "default",
    };
  });
}
