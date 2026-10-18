import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Derived per-file facts so an update re-parses only changed files. Gitignored by its own .gitignore, so Plumb
// never edits the user's .gitignore to hide it.
export const CACHE_DIR = ".plumb/cache/facts";

export type CacheMode = "read-write" | "write-only" | "off";

/**
 * Memoizes extractor work. Values always pass through JSON, hit or miss, so a cached result is
 * indistinguishable from a fresh one and an update equals a full rebuild by construction.
 */
export interface FactCache {
  /** One file's facts. The key covers the file's path and content; `context` must cover any other input. */
  file<T>(extractor: string, version: string, file: string, compute: () => T, context?: string): T;
  /**
   * Facts from many inputs; `inputs` must determine the result completely. `store` can decline a result whose
   * correctness depends on something the key can't see (a failure caused by a missing gitignored file).
   */
  keyed<T>(extractor: string, version: string, inputs: string, compute: () => Promise<T>, store?: (value: T) => boolean): Promise<T>;
  save(): void;
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type Store = Map<string, unknown>;

/**
 * `toolchain` names everything that parses files (Plumb, TypeScript, dependency-cruiser versions): any change
 * moves to a fresh directory, so facts one parser produced are never read back under another.
 */
export function createFactCache(root: string, mode: CacheMode, toolchain: string, shaOf: (file: string) => string): FactCache {
  const dir = path.join(root, CACHE_DIR, toolchain);
  const stores = new Map<string, { entries: Store; used: Store; dirty: boolean }>();

  const storeFor = (extractor: string, version: string): { entries: Store; used: Store; dirty: boolean } => {
    const name = `${extractor}@${version}`;
    let store = stores.get(name);
    if (store === undefined) {
      let entries: Store = new Map();
      const file = path.join(dir, `${name}.json`);
      if (mode === "read-write" && existsSync(file)) {
        try {
          entries = new Map(Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>));
        } catch (err) {
          // A truncated or hand-edited cache file only costs a re-extraction.
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
      store = { entries, used: new Map(), dirty: false };
      stores.set(name, store);
    }
    return store;
  };

  const lookup = <T>(extractor: string, version: string, key: string, compute: () => T): T => {
    const store = storeFor(extractor, version);
    if (mode === "read-write" && store.entries.has(key)) {
      const hit = store.entries.get(key) as T;
      store.used.set(key, hit);
      return roundTrip(hit);
    }
    const value = roundTrip(compute());
    store.used.set(key, value);
    store.dirty = true;
    return roundTrip(value);
  };

  return {
    file(extractor, version, file, compute, context = "") {
      return lookup(extractor, version, `${file}\u0000${shaOf(file)}\u0000${context}`, compute);
    },
    async keyed(extractor, version, inputs, compute, store = () => true) {
      const entries = storeFor(extractor, version);
      const key = hashOf(inputs);
      if (mode === "read-write" && entries.entries.has(key)) {
        const hit = entries.entries.get(key);
        entries.used.set(key, hit);
        return roundTrip(hit) as Awaited<ReturnType<typeof compute>>;
      }
      const value = roundTrip(await compute());
      if (store(value)) {
        entries.used.set(key, value);
        entries.dirty = true;
      }
      return roundTrip(value);
    },
    save() {
      if (mode === "off") return;
      mkdirSync(dir, { recursive: true });
      const ignore = path.join(root, ".plumb/cache/.gitignore");
      if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
      for (const [name, store] of stores) {
        // Entries not used by this build belong to old file contents; dropping them keeps the cache bounded.
        if (!store.dirty && store.used.size === store.entries.size) continue;
        writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(Object.fromEntries(store.used)));
      }
    },
  };
}
