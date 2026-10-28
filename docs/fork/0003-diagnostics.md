# Patch 0003: diagnostics

Commit `c284f38`: "Log failed requests with their reason, and browser tabs' errors, plugin load times, stalls, memory
and crashes". [Back to the fork overview](README.md).

## What it changes

### Server: the request log

- A failed request (status 400 or higher) is logged with its full, decoded path and its reason: the error's code and
  message, or the `error` field of the JSON answer. Example:
  `GET 500 /api/fs/readFile?…path=Notes/a.md… -- EPERM: operation not permitted, open '…'`.
- A batch read that skipped files lists up to five of them with the reason: `-- skipped 2: a.md (EPERM), …`.
- The client still receives only the error code. The full error is kept for the log through an `AsyncLocalStorage`
  context (`requestContext`), recorded by `sanitizeError`.
- Control characters in a logged value are replaced by spaces, so one event is one line. A failed request's path is
  cut at 300 characters, another request's at 120.
- `LOG_REQUESTS=errors` logs only failed requests, partial batch reads and requests that took 2,000 ms or more.
- `NO_COLOR` with any value leaves out the colour codes.

### Server: tab reports

A new endpoint, `POST /api/client-log`, takes `{session, device, events: []}` from browser tabs and writes one log
line per event, `client <session> …`.

| Limit | Value |
| --- | --- |
| Session id | 1–12 characters, `a-z` and `0-9`; otherwise 400 |
| Events per session | 400 per 5 minutes; the rest are counted and the count is logged |
| New sessions | 20 per minute; then 429 |
| Sessions kept | 500; then 429 |
| Session forgotten | After 1 hour without a report |

### Browser: what a tab reports

A new module, `packages/shim/src/diagnostics.js`, sends reports in batches with `navigator.sendBeacon` to the same
origin.

| Report | Contents |
| --- | --- |
| Device | The first line of a session: system, browser, device memory, window size |
| Errors | Uncaught exceptions, unhandled promise rejections, `console.error` and `console.warn`, each with the plugin whose code is on the stack (from `plugin:<id>` or `ignis-virtual/<id>.js` in the stack), the first 4 stack frames, and a repeat count |
| Start-up | When the app object, the layout and the metadata index were ready; each plugin's load time or failure |
| Stalls | Chrome's Long Animation Frames over 300 ms, with the scripts (and so the plugins) that ran |
| Memory | Chrome's JS heap, each plugin's WebAssembly memory, Ignis's note-content cache, the element count: every 15 s for the first 2 minutes, then every 60 s, and at once above 60 % of the heap limit |
| Crashes | The last heartbeat is kept in `localStorage`. A page that ended without `pagehide` is reported by the next page on the same device, with its last memory reading |

### Browser: earlier guard set-up

The set-up of patch 0001's guard and of the diagnostics switch moves to the moment the vault's file tree is known,
before Obsidian can start. Upstream's `index.html` starts Obsidian after at most 3 s even if the prefetch is still
running, and Obsidian could then read `community-plugins.json` and `workspace.json` before the guard existed. The guard
also reports what it did: which plugins it kept off, or why the list could not be used.

## Why

Ignis's log showed a failed request only by status and path, with no reason and no file. Problems in a browser tab,
especially on a phone, were visible only in that browser's developer tools. With these reports, a phone's errors,
slow plugins and crashes can be read in the server's log on the PC.

## Files touched

| File | Change |
| --- | --- |
| `apps/ignis-server/server/index.js` | Request logger with reasons; `LOG_REQUESTS`, `NO_COLOR`; `POST /api/client-log` |
| `apps/ignis-server/server/routes/fs.js` | Batch read records skipped files and their reasons |
| `packages/server-core/src/errors.js` | `requestContext`; `sanitizeError` records the full error |
| `packages/server-core/src/index.js` | Exports `requestContext` |
| `packages/shim/src/diagnostics.js` | New: the tab reports |
| `packages/shim/src/diagnostics.test.js` | New: tests |
| `packages/shim/src/loader.js` | Installs the diagnostics at load |
| `packages/shim/src/init.js` | Earlier guard set-up; reads the diagnostics switch |
| `packages/shim/src/guards/local-plugins-guard.js` | Reports of what the guard did |

## Configuration

| Item | Value | Default |
| --- | --- | --- |
| `LOG_REQUESTS` | `errors`: log only failures, partial batch reads and requests of 2,000 ms or more | unset: every request is logged |
| `NO_COLOR` | Any non-empty value: no colour codes | unset: coloured status codes |
| `.obsidian/ignis-diagnostics.json` in the vault | `{"enabled": false}` turns tab reports off | no file: on |

The vault file is read when a tab loads. Until it has been read, events are held, not sent. Ignis Control's
**Browser tabs → Diagnostics** setting writes this file. Ignis Control's launcher sets `LOG_REQUESTS=errors` and
`NO_COLOR=1`.

## Behaviour when not configured

- Every request is logged with colours, as upstream does. Failed requests carry their reason.
- Every tab sends reports to `POST /api/client-log`, and the server logs them.
