import { describe, it, expect, vi } from "vitest";
import { PersistentCache, isPersistable } from "./persistent-cache.js";

// The IndexedDB backend's interface, in memory
function memoryBackend({ failPut = false } = {}) {
  const meta = new Map();
  const data = new Map();

  return {
    meta,
    data,
    open: async () => {},
    loadMeta: async () => [...meta.entries()].map(([k, v]) => [k, { ...v }]),
    getData: async (k) => (data.has(k) ? data.get(k) : undefined),
    put: async (k, m, d) => {
      if (failPut) throw new Error("QuotaExceededError");
      meta.set(k, { ...m });
      data.set(k, d);
    },
    putMeta: async (entries) => entries.forEach(([k, m]) => meta.set(k, { ...m })),
    delete: async (keys) => keys.forEach((k) => (meta.delete(k), data.delete(k))),
    clear: async () => (meta.clear(), data.clear()),
  };
}

const cache = (backend, capBytes = 1000) => {
  const c = new PersistentCache(backend, { capBytes });
  c.configure({ vaultId: "Vault" });
  return c;
};

describe("isPersistable", () => {
  it("keeps .obsidian files only", () => {
    expect(isPersistable(".obsidian/plugins/quarry/quarry.wasm")).toBe(true);
    expect(isPersistable("/.obsidian/app.json")).toBe(true);
    expect(isPersistable("Library/note.md")).toBe(false);
    expect(isPersistable(".obsidianx/a.js")).toBe(false);
  });
});

describe("PersistentCache", () => {
  const path = ".obsidian/plugins/a/main.js";
  const meta = { mtime: 1, size: 3 };

  it("returns a kept file while its mtime and size match", async () => {
    const b = memoryBackend();
    const c = cache(b);
    await c.put(path, meta, "abc");

    const again = cache(b); // a later visit
    expect(await again.get(path, meta)).toBe("abc");
    expect(again.stats.hits).toBe(1);
  });

  it("drops a kept file whose mtime or size changed", async () => {
    const b = memoryBackend();
    await cache(b).put(path, meta, "abc");

    const c = cache(b);
    expect(await c.get(path, { mtime: 2, size: 3 })).toBeNull();
    expect(b.data.size).toBe(0);
  });

  it("keeps binary data", async () => {
    const b = memoryBackend();
    const bytes = new Uint8Array([1, 2, 3]);
    await cache(b).put(".obsidian/plugins/s/s.wasm", meta, bytes);
    expect(await cache(b).get(".obsidian/plugins/s/s.wasm", meta)).toEqual(bytes);
  });

  it("never keeps notes", async () => {
    const b = memoryBackend();
    await cache(b).put("Library/a.md", meta, "abc");
    expect(b.data.size).toBe(0);
  });

  it("stays under the cap by dropping the least recently used", async () => {
    vi.useFakeTimers();
    const b = memoryBackend();
    const c = cache(b, 1000);
    vi.setSystemTime(1000);
    await c.put(".obsidian/a.json", { mtime: 1, size: 200 }, "a".repeat(200));
    vi.setSystemTime(2000);
    await c.put(".obsidian/b.json", { mtime: 1, size: 200 }, "b".repeat(200));
    vi.setSystemTime(3000);
    await c.get(".obsidian/a.json", { mtime: 1, size: 200 }); // a used after b
    vi.setSystemTime(4000);
    await c.put(".obsidian/c.json", { mtime: 1, size: 200 }, "c".repeat(200));
    await c.put(".obsidian/d.json", { mtime: 1, size: 200 }, "d".repeat(200));
    vi.setSystemTime(5000);
    await c.put(".obsidian/e.json", { mtime: 1, size: 250 }, "e".repeat(250));
    expect(c.totalBytes).toBeLessThanOrEqual(1000);
    expect(b.data.has("Vault\n.obsidian/b.json")).toBe(false); // least recently used went first
    expect(b.data.has("Vault\n.obsidian/a.json")).toBe(true);
    expect(c.stats.evicted).toBe(1);
    vi.useRealTimers();
  });

  it("does not keep a file over a quarter of the cap", async () => {
    const b = memoryBackend();
    const c = cache(b, 1000);
    await c.put(path, { mtime: 1, size: 300 }, "x".repeat(300));
    expect(b.data.size).toBe(0);
    expect(c.stats.skipped).toBe(1);
  });

  it("applies a lowered cap at the next start", async () => {
    const b = memoryBackend();
    const c = cache(b, 1000);
    for (const n of ["a", "b", "c"]) await c.put(`.obsidian/${n}.json`, { mtime: 1, size: 200 }, n.repeat(200));
    const smaller = cache(b, 450);
    await smaller.ready();
    expect(smaller.totalBytes).toBeLessThanOrEqual(450);
    expect(b.data.size).toBe(2);
  });

  it("with the cap at 0, keeps nothing and empties the store", async () => {
    const b = memoryBackend();
    await cache(b).put(path, meta, "abc");
    const off = cache(b, 0);
    await off.ready();
    expect(await off.get(path, meta)).toBeNull();
    expect(b.data.size).toBe(0);
  });

  it("stops using the store after it fails (quota), without throwing", async () => {
    const c = cache(memoryBackend({ failPut: true }));
    await c.put(path, meta, "abc");
    expect(c.stats.error).toMatch(/Quota/);
    expect(c.enabled).toBe(false);
    expect(await c.get(path, meta)).toBeNull();
  });

  it("keeps vaults apart", async () => {
    const b = memoryBackend();
    await cache(b).put(path, meta, "abc");
    const other = new PersistentCache(b, { capBytes: 1000 });
    other.configure({ vaultId: "Other" });
    expect(await other.get(path, meta)).toBeNull();
  });
});
