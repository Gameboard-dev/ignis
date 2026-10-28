// Local patch (Ignis Control, 2026-10-27; patches/0004-mobile.patch): ask the browser to keep this site's storage.
// Obsidian keeps its metadata index (headings, blocks, links of every note) in IndexedDB, built once per device; a
// phone's browser may clear "best-effort" storage when space runs low, and the next visit would index the whole vault
// again. A persisted origin is cleared only by the user. Chrome decides by itself (site engagement, a bookmark, an
// installed app) and answers at once, without a prompt; Firefox may ask. The answer goes to the tab report.
// https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist

import { report } from "./diagnostics.js";
import { persistentCache } from "./fs/persistent-cache.js";

const mb = (b) => (Number.isFinite(b) ? `${(b / 1048576).toFixed(1)} MB` : "?");

// What the kept .obsidian files saved this visit (fs/persistent-cache.js), 30 s after start: by then the plugins have
// loaded and read their files.
function reportPersistentCache() {
  const s = persistentCache.stats;

  if (!persistentCache.capBytes) {
    report("cache", "info", "kept plugin and settings files: off (persistentCacheBytes is 0)");
  } else if (s.error) {
    report("cache", "warn", `kept plugin and settings files: not used this visit (${s.error})`);
  } else {
    report("cache", "info", `kept plugin and settings files: ${s.hits} taken from this browser (${mb(s.hitBytes)} not downloaded),`
      + ` ${s.stored} downloaded and kept (${mb(s.storedBytes)}), ${s.evicted} dropped to stay under the cap,`
      + ` ${s.skipped} too large to keep; ${mb(persistentCache.totalBytes)} kept of ${mb(persistentCache.capBytes)}`);
  }
}

export async function requestPersistentStorage() {
  setTimeout(reportPersistentCache, 30000);
  const storage = navigator.storage;

  if (!storage?.persist || !storage.persisted) {
    report("storage", "warn", "this browser cannot be asked to keep the site's storage: the note index may be cleared");
    return;
  }

  try {
    const already = await storage.persisted();
    const granted = already || (await storage.persist());
    const { usage, quota } = storage.estimate ? await storage.estimate() : {};

    report("storage", granted ? "info" : "warn", granted
      ? `site storage is kept (${already ? "already" : "granted now"}); ${mb(usage)} used of ${mb(quota)}`
      : `the browser did not agree to keep the site's storage (it decides by use, a bookmark or an installed app);`
        + ` the note index may be cleared when space runs low; ${mb(usage)} used of ${mb(quota)}`);
  } catch (e) {
    report("storage", "warn", `asking to keep the site's storage failed: ${e?.message || e}`);
  }
}
