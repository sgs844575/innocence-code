import type { Context } from "@innocencecode/kernel";
import type { Fiber } from "@innocencecode/kernel";

/**
 * Serialized options of one configured plugin entry.
 *
 * Entries loaded by a config tree (the loader service, the include builtin)
 * describe the plugin they want mounted; `options.id` stays the raw row id
 * while the composite id lives on {@link LoaderEntry.id}.
 */
export interface EntryOptions {
  /** Stable id inside the containing entry tree. */
  id: string;
  /** Builtin name (`kernel:` prefix) or module specifier to import. */
  name: string;
  /** Config carried by the entry; read by the plugin via `ctx.entry`. */
  config?: unknown;
  /** Skip importing and mounting this entry and its subtree. */
  disabled?: boolean;
}

/** Options accepted by tree creation; the id is assigned when omitted. */
export type EntryCreateOptions = Omit<EntryOptions, "id"> & Partial<Pick<EntryOptions, "id">>;

/**
 * One configured plugin node inside a {@link LoaderTree}.
 *
 * An entry is a plain data node: it keeps the row options, the fiber of the
 * mounted plugin (absent while disabled or not yet started), and the subtree
 * another config carrier (the include builtin) mounted on it.
 */
export class LoaderEntry {
  /** Fiber of the mounted plugin; `undefined` until (and unless) started. */
  fiber?: Fiber;
  /** Tree mounted below this entry by a config carrier, if any. */
  subtree?: LoaderTree;

  constructor(readonly tree: LoaderTree, readonly options: EntryOptions) {}

  /**
   * Composite id across subtree boundaries: subtree rows are prefixed with
   * the id of the entry that carries their tree.
   */
  get id(): string {
    return this.tree.owner ? `${this.tree.owner.id}${LoaderTree.sep}${this.options.id}` : this.options.id;
  }
}

/**
 * Mutable tree of loader entries.
 *
 * The root tree belongs to the loader service; nested trees mount on entries
 * (`owner`) so their rows compose prefixed ids and unwind together with the
 * owner's fiber.
 */
export class LoaderTree {
  /** Separator between the subtree owner id and the row id. */
  static readonly sep = ":";

  readonly store = new Map<string, LoaderEntry>();

  constructor(readonly ctx: Context, readonly owner: LoaderEntry | null = null) {}

  /** Iterate this tree's entries, then recurse into mounted subtrees. */
  *entries(): Generator<LoaderEntry, void, void> {
    for (const entry of this.store.values()) {
      yield entry;
      if (entry.subtree) yield* entry.subtree.entries();
    }
  }

  /**
   * Resolve an entry by composite id, walking subtrees segment by segment.
   *
   * @throws when any segment names no subtree-carrying entry.
   */
  resolve(id: string): LoaderEntry {
    const parts = id.split(LoaderTree.sep);
    const last = parts.pop()!;
    let tree: LoaderTree | undefined = this;
    for (const part of parts) {
      tree = tree.store.get(part)?.subtree;
      if (!tree) throw new Error(`cannot resolve loader entry ${id}`);
    }
    const entry = tree.store.get(last);
    if (!entry) throw new Error(`cannot resolve loader entry ${id}`);
    return entry;
  }

  /**
   * Add an entry from `options`, assigning a fresh id when omitted.
   *
   * @throws when the assigned id already exists in this tree.
   */
  add(options: EntryCreateOptions): LoaderEntry {
    const id = options.id ?? freshId(this.store);
    if (this.store.has(id)) throw new Error(`duplicate loader entry id ${id}`);
    const entry = new LoaderEntry(this, { ...options, id });
    this.store.set(id, entry);
    return entry;
  }
}

/** Random row id that does not collide with the tree's taken ids. */
function freshId(taken: ReadonlyMap<string, unknown>): string {
  let id: string;
  do {
    id = Math.random().toString(16).slice(2, 10);
  } while (taken.has(id));
  return id;
}
