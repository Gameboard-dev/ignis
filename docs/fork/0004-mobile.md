# Patch 0004: mobile

Commit `c213940`: "Keep the site's storage and cache unchanged .obsidian files in the browser between visits".
[Back to the fork overview](README.md).

## What it changes

### Persistent storage

At load, the page calls `navigator.storage.persist()`, which asks the browser not to clear the site's storage on its
own. The answer (granted or not, with usage and quota) goes to the tab report (patch 0003). Chrome decides without a
prompt; Firefox may ask the user.

### Kept `.obsidian` files

Files under `.obsidian/` (settings, plugins' code, styles and WebAssembly) are kept in the browser's IndexedDB between
visits.

- **Validity.** A kept copy is used only while the file's modification time and size, from the vault listing Ignis
  sends at each start, still match. Any change on the server fetches the file again and replaces the copy.
- **Size.** At most `persistentCacheBytes` in all. The least recently used files are dropped first. A single file
  larger than a quarter of that limit is not kept. `0` keeps none and empties the store.
- **Scope.** Only `.obsidian/`. Notes are not kept; Obsidian keeps its own index.
- **Storage.** The IndexedDB database `ignis-persistent-files`, with the stores `meta` (each file's validator, size
  and last use) and `data` (the contents).
- **Prefetch.** Ignis's start-up prefetch uses kept copies, and its log line adds `, <n> of them kept from an earlier
  visit`.
- **Report.** 30 s after start, the tab reports (patch 0003) how many files were taken from the browser, downloaded
  and kept, dropped to stay under the limit, and skipped as too large.

### Server setting

A new server setting, `persistentCacheBytes`, is sent to each tab with the other settings, and accepted by
`POST /api/settings`.

## Why

- Obsidian keeps its metadata index (headings, blocks and links of every note) in IndexedDB, built once per device. A
  phone's browser may clear "best-effort" storage when space runs low, and the next visit then rebuilds the index for
  the whole vault, which takes time and memory. A persisted site is cleared only by the user.
- Without the kept files, a phone downloads every plugin's code and styles again at every start.

## Files touched

| File | Change |
| --- | --- |
| `packages/shim/src/persistent-storage.js` | New: `navigator.storage.persist()` and its report |
| `packages/shim/src/fs/persistent-cache.js` | New: the kept-files store |
| `packages/shim/src/fs/persistent-cache.test.js` | New: tests, with an in-memory backend |
| `packages/shim/src/fs/promises.js` | Reads use kept copies; fetched files are stored |
| `packages/shim/src/fs/indexer-prefetch.js` | The prefetch uses and stores kept copies |
| `packages/shim/src/init.js` | Applies `persistentCacheBytes` from the server settings |
| `packages/shim/src/loader.js` | Requests persistent storage at load |
| `apps/ignis-server/server/settings.js` | Default `persistentCacheBytes` |
| `apps/ignis-server/server/routes/settings.js` | Validates `persistentCacheBytes` |
| `apps/ignis-server/server/cache/crawl.js` | Sends `persistentCacheBytes` to tabs |

## Configuration

| Setting | Where | Default | Range |
| --- | --- | --- | --- |
| `persistentCacheBytes` | Server setting: `data/server-settings.json`, or `POST /api/settings` | 104,857,600 (100 MB) | 0 to 2,147,483,648 (2 GB); 0 turns the kept files off |

A changed value reaches a tab when it next loads. Ignis Control's **Kept plugin and settings files** slider sets it.

## Behaviour when not configured

- The browser is asked to keep the site's storage at every load.
- Up to 100 MB of `.obsidian` files are kept in each browser.
