/**
 * Content-addressed object store for workspace snapshots.
 *
 * Objects live at `<storage root>/objects/<sha256>` and are written through
 * the secure-storage API (0600 / current-user-only ACL, atomic install).
 * Identical content is stored exactly once: the key IS the content hash, so
 * a put of known content never rewrites the object file.
 */
import { createHash } from "node:crypto";
import type { SecureStorage } from "@innocencecode/secure-storage-node";

export interface ContentKey {
  key: string;
}

export interface ContentStore {
  /** Stores content under its sha256 key; returns the (deduplicated) key. */
  put(content: Uint8Array): Promise<ContentKey>;
  /** True when an object with this key exists (accepts a previous put result). */
  has(key: string | ContentKey): Promise<boolean>;
  /** Reads back the exact bytes stored under a key. */
  get(key: string): Promise<Uint8Array>;
  /** Absolute path of an object file (validated key). */
  path(key: string): string;
}

/** Raw sha256 hex of arbitrary bytes; the object key and the snapshot hash. */
export function sha256Bytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function assertObjectKey(key: string): string {
  if (!SHA256_HEX.test(key)) {
    throw new Error(`content store: invalid object key: ${JSON.stringify(key)}`);
  }
  return key;
}

export function createContentStore(storage: SecureStorage): ContentStore {
  return {
    async put(content: Uint8Array): Promise<ContentKey> {
      const key = sha256Bytes(content);
      if (!(await this.has(key))) {
        await storage.writeFileAtomic(`objects/${key}`, content);
      }
      return { key };
    },

    async has(key: string | ContentKey): Promise<boolean> {
      const value = typeof key === "string" ? key : key.key;
      return storage.fileExists(`objects/${assertObjectKey(value)}`);
    },

    async get(key: string): Promise<Uint8Array> {
      return storage.readFile(`objects/${assertObjectKey(key)}`);
    },

    path(key: string): string {
      return storage.resolve(`objects/${assertObjectKey(key)}`);
    },
  };
}
