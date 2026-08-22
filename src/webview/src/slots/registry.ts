// 槽位注册表——纯逻辑实现，零视图层与宿主依赖。
// 语义契约（与任务简报钉死一致）：
//   single：后注覆盖先注；注销只撤自身记录，不误撤后来者；撤覆盖者回落。
//   list：按注册序保序；注销按记录移除；all() 返回缓存快照（身份稳定）。
//   keyed：resolve = 精确 key 命中（priority 高者胜、同值后注胜）→
//          "prefix:" 声明条目的最长匹配前缀（等长时同规则比较）→ undefined。
import type { KeyedContribution, KeyedSlot, ListSlot, SingleSlot } from "./types";

/** 前缀声明记号：注册 key 形如 "prefix:abc" 表示按前缀 "abc" 匹配。 */
const PREFIX_MARK = "prefix:";

/** single/list 槽位的注册记录；removed 标记支撑幂等注销。 */
interface Registration {
  payload: unknown;
  removed: boolean;
}

/** keyed 槽位的注册记录。 */
interface KeyedEntry {
  key: string;
  priority: number;
  value: unknown;
  removed: boolean;
}

/** 每个 slot 标识一份共享状态；三类槽位状态独立、订阅按 slot 标识聚合。 */
interface SlotRecord {
  singleStack?: Registration[];
  listEntries?: Registration[];
  listSnapshot?: readonly unknown[];
  keyedEntries?: KeyedEntry[];
  listeners: Set<() => void>;
}

/**
 * 槽位注册表：同一 slot 标识多次取用共享同一份状态。
 * subscribe 为视图层外部存储订阅预留——命令式 register/注销也会通知。
 */
export interface SlotRegistry {
  single<T>(slot: string): SingleSlot<T>;
  list<T>(slot: string): ListSlot<T>;
  keyed<T>(slot: string): KeyedSlot<T>;
  /** 订阅该槽位的任一注册/注销；返回退订函数。 */
  subscribe(slot: string, listener: () => void): () => void;
}

function noop(): void {}

/** 拷贝监听器后遍历：允许监听者在回调中安全退订。 */
function notify(record: SlotRecord): void {
  for (const listener of [...record.listeners]) listener();
}

/** 构造注销闭包：只撤自身记录；重复调用为无害空操作。 */
function unregisterFrom(
  entries: Array<{ removed: boolean }>,
  self: { removed: boolean },
  record: SlotRecord,
  onRemoved: () => void,
): () => void {
  return () => {
    if (self.removed) return;
    self.removed = true;
    const index = entries.indexOf(self);
    if (index >= 0) entries.splice(index, 1);
    onRemoved();
    notify(record);
  };
}

function createSingle<T>(record: SlotRecord): SingleSlot<T> {
  return {
    register(contribution: T): () => void {
      const stack = (record.singleStack ??= []);
      const self: Registration = { payload: contribution, removed: false };
      stack.push(self);
      notify(record);
      return unregisterFrom(stack, self, record, noop);
    },
    get(): T | undefined {
      const stack = record.singleStack;
      const top = stack !== undefined && stack.length > 0 ? stack[stack.length - 1] : undefined;
      return top === undefined ? undefined : (top.payload as T);
    },
  };
}

function createList<T>(record: SlotRecord): ListSlot<T> {
  return {
    register(contribution: T): () => void {
      const entries = (record.listEntries ??= []);
      const self: Registration = { payload: contribution, removed: false };
      entries.push(self);
      record.listSnapshot = undefined;
      notify(record);
      return unregisterFrom(entries, self, record, () => {
        record.listSnapshot = undefined;
      });
    },
    all(): readonly T[] {
      if (record.listSnapshot === undefined) {
        record.listSnapshot = (record.listEntries ?? []).map((entry) => entry.payload);
      }
      return record.listSnapshot as readonly T[];
    },
  };
}

/** 遍历选出胜者：rank 为匹配长度（精确轮恒 0）；同 rank 比 priority 降序，再比后注。 */
function pickWinner(entries: readonly KeyedEntry[], name: string, prefixPass: boolean): KeyedEntry | undefined {
  let best: { entry: KeyedEntry; index: number; rank: number } | undefined;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    let rank: number;
    if (prefixPass) {
      if (!entry.key.startsWith(PREFIX_MARK)) continue;
      const prefix = entry.key.slice(PREFIX_MARK.length);
      // 空前缀视为无效声明，避免误配一切名字。
      if (prefix === "" || !name.startsWith(prefix)) continue;
      rank = prefix.length;
    } else {
      if (entry.key !== name) continue;
      rank = 0;
    }
    const wins =
      best === undefined ||
      rank > best.rank ||
      (rank === best.rank &&
        (entry.priority > best.entry.priority ||
          (entry.priority === best.entry.priority && index > best.index)));
    if (wins) best = { entry, index, rank };
  }
  return best?.entry;
}

function createKeyed<T>(record: SlotRecord): KeyedSlot<T> {
  return {
    register(c: KeyedContribution<T>): () => void {
      const entries = (record.keyedEntries ??= []);
      const self: KeyedEntry = { key: c.key, priority: c.priority ?? 0, value: c.value, removed: false };
      entries.push(self);
      notify(record);
      return unregisterFrom(entries, self, record, noop);
    },
    resolve(name: string): T | undefined {
      const entries = record.keyedEntries ?? [];
      const exact = pickWinner(entries, name, false);
      if (exact !== undefined) return exact.value as T;
      const prefixed = pickWinner(entries, name, true);
      return prefixed === undefined ? undefined : (prefixed.value as T);
    },
  };
}

export function createSlotRegistry(): SlotRegistry {
  const records = new Map<string, SlotRecord>();

  function recordOf(slot: string): SlotRecord {
    let record = records.get(slot);
    if (record === undefined) {
      record = { listeners: new Set() };
      records.set(slot, record);
    }
    return record;
  }

  return {
    single<T>(slot: string): SingleSlot<T> {
      return createSingle<T>(recordOf(slot));
    },
    list<T>(slot: string): ListSlot<T> {
      return createList<T>(recordOf(slot));
    },
    keyed<T>(slot: string): KeyedSlot<T> {
      return createKeyed<T>(recordOf(slot));
    },
    subscribe(slot: string, listener: () => void): () => void {
      const record = recordOf(slot);
      record.listeners.add(listener);
      return () => {
        record.listeners.delete(listener);
      };
    },
  };
}
