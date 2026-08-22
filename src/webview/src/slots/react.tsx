// 槽位系统的视图层绑定：Provider 持有 registry 实例；
// 注册钩子在 effect 挂载注册/卸载注销/依赖变化重注册；
// 读取钩子经外部存储订阅（槽位级变更通知）触发重渲染。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createSlotRegistry, type SlotRegistry } from "./registry";
import type { KeyedContribution } from "./types";

const SlotContext = createContext<SlotRegistry | null>(null);

/** 槽位上下文提供者；可注入外部 registry（测试/宿主复用），缺省自持实例。 */
export function SlotProvider({
  registry,
  children,
}: {
  registry?: SlotRegistry;
  children: ReactNode;
}): React.JSX.Element {
  const [owned] = useState(() => createSlotRegistry());
  const value = registry ?? owned;
  return <SlotContext.Provider value={value}>{children}</SlotContext.Provider>;
}

function useRegistry(): SlotRegistry {
  const registry = useContext(SlotContext);
  if (registry === null) throw new Error("slots hooks require <SlotProvider>");
  return registry;
}

/** 单值注册：contribution 变化时先注销旧值再注册新值。 */
export function useRegisterSingle<T>(slot: string, contribution: T): void {
  const registry = useRegistry();
  useEffect(
    () => registry.single<T>(slot).register(contribution),
    [registry, slot, contribution],
  );
}

/** 列表注册：contribution 变化时先注销旧条目再注册新条目。 */
export function useRegisterList<T>(slot: string, contribution: T): void {
  const registry = useRegistry();
  useEffect(
    () => registry.list<T>(slot).register(contribution),
    [registry, slot, contribution],
  );
}

/** 键控注册：按 key/priority/value 原语比对依赖，避免外层对象重建导致的注册抖动。 */
export function useRegisterKeyed<T>(slot: string, contribution: KeyedContribution<T>): void {
  const registry = useRegistry();
  const { key, priority, value } = contribution;
  useEffect(
    () => registry.keyed<T>(slot).register({ key, priority, value }),
    [registry, slot, key, priority, value],
  );
}

/** 订阅指定槽位的变更（命令式 register/注销同样触发通知）。 */
function useSlotSubscribe(registry: SlotRegistry, slot: string): (onStoreChange: () => void) => () => void {
  return useCallback(
    (onStoreChange: () => void) => registry.subscribe(slot, onStoreChange),
    [registry, slot],
  );
}

/** 读取单值槽位当前生效值。 */
export function useSingleSlot<T>(slot: string): T | undefined {
  const registry = useRegistry();
  const subscribe = useSlotSubscribe(registry, slot);
  const getSnapshot = useCallback(() => registry.single<T>(slot).get(), [registry, slot]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** 读取列表槽位快照（注册序）。 */
export function useSlotList<T>(slot: string): readonly T[] {
  const registry = useRegistry();
  const subscribe = useSlotSubscribe(registry, slot);
  const getSnapshot = useCallback(() => registry.list<T>(slot).all(), [registry, slot]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** 按名字解析键控槽位（精确 key → 最长前缀）。 */
export function useSlotKeyedResolve<T>(slot: string, name: string): T | undefined {
  const registry = useRegistry();
  const subscribe = useSlotSubscribe(registry, slot);
  const getSnapshot = useCallback(
    () => registry.keyed<T>(slot).resolve(name),
    [registry, slot, name],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
