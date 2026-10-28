// Local patch (Ignis Control, 2026-10-27; patches/0004-mobile.patch): files under .obsidian/ (settings, plugins'
// code, styles and WebAssembly) kept in the browser between visits, so a phone does not download them again at every
// start (18.9 MB for 21 plugins on 2026-10-27, 12.1 MB of it TikZJax). A kept copy is used only while the file's
// modification time and size, from the vault listing Ignis sends at each start, still match; any change on the
// server fetches the file again and replaces the copy. Notes are not kept here (Obsidian keeps its own index).
//
// Size: at most `capBytes` in all (the server setting persistentCacheBytes, set in Ignis Control; 0 turns it off and
// empties it); the least recently used files are dropped first, and a single file over a quarter of the cap is not
// kept. Sizes are counted as stored: a string by its length, binary by its bytes.
//
// Storage: IndexedDB ("ignis-persistent-files": "meta" holds each file's validator, size and last use, small enough to
// load whole at start; "data" holds the contents, read one at a time). The backend is an interface so the logic is
// tested without a browser (persistent-cache.test.js).
// https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API

import { normalize } from "../util/path.js";

export const DEFAULT_CAP_BYTES = 100 * 1024 * 1024;
const MAX_FILE_FRACTION = 0.25;
const TOUCH_DELAY_MS = 2000;

export function isPersistable(path) {
  return normalize(path).startsWith(".obsidian/");
}

function byteLength(data) {
  if (typeof data === "string") {
    return data.length;
  }

  return data?.byteLength ?? 0;
}

export class PersistentCache {
  constructor(backend, { capBytes = DEFAULT_CAP_BYTES } = {}) {
    this._backend = backend;
    this._cap = capBytes;
    this._vault = "";
    this._index = new Map(); // key -> { mtime, size, bytes, usedAt }
    this._total = 0;
    this._ready = null;
    this._touched = new Set();
    this._touchTimer = null;
    this.stats = { hits: 0, hitBytes: 0, misses: 0, stored: 0, storedBytes: 0, evicted: 0, skipped: 0, error: "" };
  }

  configure({ capBytes, vaultId } = {}) {
    if (Number.isFinite(capBytes) && capBytes >= 0) {
      this._cap = capBytes;
    }

    if (typeof vaultId === "string") {
      this._vault = vaultId;
    }
  }

  get enabled() {
    return this._cap > 0 && !this.stats.error;
  }

  get totalBytes() {
    return this._total;
  }

  get capBytes() {
    return this._cap;
  }

  _key(path) {
    return `${this._vault}\n${normalize(path)}`;
  }

  // Load the index (once); with the cap at 0, empty the store instead.
  ready() {
    if (!this._ready) {
      this._ready = (async () => {
        try {
          await this._backend.open();

          if (this._cap === 0) {
            await this._backend.clear();
            return;
          }

          for (const [key, meta] of await this._backend.loadMeta()) {
            this._index.set(key, meta);
            this._total += meta.bytes || 0;
          }

          await this._fitWithin(this._cap); // the cap may have been lowered since the last visit
        } catch (e) {
          this.stats.error = e?.message || String(e);
        }
      })();
    }

    return this._ready;
  }

  // The kept copy of `path`, if its modification time and size still match `meta` ({ mtime, size }); else null.
  async get(path, meta) {
    if (!this.enabled || !isPersistable(path) || !meta) {
      return null;
    }

    await this.ready();

    const key = this._key(path);
    const kept = this._index.get(key);

    if (!kept) {
      this.stats.misses++;
      return null;
    }

    if (kept.mtime !== meta.mtime || kept.size !== meta.size) {
      this.stats.misses++;
      await this._drop([key]);
      return null;
    }

    let data = null;

    try {
      data = await this._backend.getData(key);
    } catch {
      data = null;
    }

    if (data === null || data === undefined) {
      this.stats.misses++;
      await this._drop([key]);
      return null;
    }

    kept.usedAt = Date.now();
    this._touch(key);
    this.stats.hits++;
    this.stats.hitBytes += kept.bytes;

    return data;
  }

  // Keep `data`, read from the server when the file had `meta` ({ mtime, size }).
  async put(path, meta, data) {
    if (!this.enabled || !isPersistable(path) || !meta || data === null || data === undefined) {
      return;
    }

    await this.ready();

    const bytes = byteLength(data);

    if (bytes > this._cap * MAX_FILE_FRACTION) {
      this.stats.skipped++;
      return;
    }

    const key = this._key(path);

    if (this._index.has(key)) {
      await this._drop([key]);
    }

    await this._fitWithin(this._cap - bytes);

    const entry = { mtime: meta.mtime, size: meta.size, bytes, usedAt: Date.now() };

    try {
      await this._backend.put(key, entry, data);
      this._index.set(key, entry);
      this._total += bytes;
      this.stats.stored++;
      this.stats.storedBytes += bytes;
    } catch (e) {
      // Quota exceeded or storage gone: stop using it for this visit
      this.stats.error = e?.message || String(e);
    }
  }

  // Drop the least recently used entries until the total is at most `limit`.
  async _fitWithin(limit) {
    if (this._total <= limit) {
      return;
    }

    const oldest = [...this._index.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    const drop = [];
    let total = this._total;

    for (const [key, meta] of oldest) {
      if (total <= limit) {
        break;
      }

      drop.push(key);
      total -= meta.bytes || 0;
    }

    this.stats.evicted += drop.length;
    await this._drop(drop);
  }

  async _drop(keys) {
    for (const key of keys) {
      const meta = this._index.get(key);

      if (meta) {
        this._total -= meta.bytes || 0;
        this._index.delete(key);
      }

      this._touched.delete(key);
    }

    if (keys.length) {
      try {
        await this._backend.delete(keys);
      } catch {
        // gone already
      }
    }
  }

  // Last-use times are written in batches, not on every read
  _touch(key) {
    this._touched.add(key);

    if (!this._touchTimer) {
      this._touchTimer = setTimeout(() => {
        this._touchTimer = null;
        const entries = [...this._touched].filter((k) => this._index.has(k)).map((k) => [k, this._index.get(k)]);
        this._touched.clear();
        this._backend.putMeta(entries).catch(() => {});
      }, TOUCH_DELAY_MS);
    }
  }
}

// --- the IndexedDB backend ---

function request(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
  });
}

export function indexedDbBackend(name = "ignis-persistent-files") {
  let db = null;
  const tx = (stores, mode) => db.transaction(stores, mode, { durability: "relaxed" });

  return {
    async open() {
      if (typeof indexedDB === "undefined") {
        throw new Error("no IndexedDB in this browser");
      }

      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("meta");
        open.result.createObjectStore("data");
      };
      db = await request(open);
    },

    async loadMeta() {
      const store = tx(["meta"], "readonly").objectStore("meta");
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);

      return keys.map((k, i) => [k, values[i]]);
    },

    async getData(key) {
      return request(tx(["data"], "readonly").objectStore("data").get(key));
    },

    async put(key, meta, data) {
      const t = tx(["meta", "data"], "readwrite");
      t.objectStore("data").put(data, key);
      t.objectStore("meta").put(meta, key);
      await done(t);
    },

    async putMeta(entries) {
      const t = tx(["meta"], "readwrite");

      for (const [key, meta] of entries) {
        t.objectStore("meta").put(meta, key);
      }

      await done(t);
    },

    async delete(keys) {
      const t = tx(["meta", "data"], "readwrite");

      for (const key of keys) {
        t.objectStore("meta").delete(key);
        t.objectStore("data").delete(key);
      }

      await done(t);
    },

    async clear() {
      const t = tx(["meta", "data"], "readwrite");
      t.objectStore("meta").clear();
      t.objectStore("data").clear();
      await done(t);
    },
  };
}

export const persistentCache = new PersistentCache(indexedDbBackend());
