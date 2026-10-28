# This fork of Ignis

This repository is a fork of [Ignis](https://github.com/Nystik-gh/ignis) by Nystik. It adds six patches that
[Ignis Control](https://github.com/Gameboard-dev/ignis-control) depends on. Ignis Control runs Ignis natively on
Windows inside an AppContainer sandbox, publishes it through a Cloudflare Tunnel behind Cloudflare Access, and relays
requests from plugins in the browser to services on the PC.

The pages in `docs/fork/` document only what this fork adds. Everything else is upstream's: see the
[README](../../README.md), [ARCHITECTURE.md](../ARCHITECTURE.md) and
[ignis.thiefling.com/docs](https://ignis.thiefling.com/docs/).

## Base

| Item | Value |
| --- | --- |
| Upstream | [Nystik-gh/ignis](https://github.com/Nystik-gh/ignis) |
| Upstream release | `v0.8.18+obsidian.1.14.4` (commit `d65e2f3`): Ignis 0.8.18, pinned to Obsidian 1.14.4 |
| Branch | `main`: upstream's history up to that tag, then one commit per patch, then documentation commits |
| Licence | GNU Affero General Public License 3.0 or later, as upstream ([LICENSE](../../LICENSE), unchanged) |

## How it differs from upstream

| Patch | Commit | Summary | Configuration |
| --- | --- | --- | --- |
| [0001 Local plugins guard](0001-local-plugins-guard.md) | `a0d29c2` | Plugins listed in `.obsidian/ignis-disabled-plugins.json` stay off in Ignis; desktop's plugin switches are followed in open tabs; Ignis keeps its own `workspace-ignis.json` | Vault file `.obsidian/ignis-disabled-plugins.json` |
| [0002 Listen host](0002-listen-host.md) | `c436038` | `HOST` sets the address the server listens on | `HOST` |
| [0003 Diagnostics](0003-diagnostics.md) | `c284f38` | Failed requests are logged with their reason and file; browser tabs report errors, plugin load times, stalls, memory and crashes to the server's log | `LOG_REQUESTS`, `NO_COLOR`, vault file `.obsidian/ignis-diagnostics.json` |
| [0004 Mobile](0004-mobile.md) | `c213940` | The browser is asked to keep the site's storage; unchanged `.obsidian` files are kept in the browser between visits | Server setting `persistentCacheBytes` |
| [0005 Startup](0005-startup.md) | `f832a88` | The two browser bundles are built minified, with readable copies outside what the server serves; the page gets the class `is-ignis` | none |
| [0006 Relay](0006-relay.md) | `a0b469d` | A same-origin relay, `/relay/<service>/…`, through a named pipe to a process outside the server | `IGNIS_LOCAL_RELAY` |

Without any of the new configuration, the fork behaves as upstream except for these differences:

- Ignis saves its layout to `.obsidian/workspace-ignis.json` instead of `workspace.json` (0001).
- Open tabs follow changes to `.obsidian/community-plugins.json` made by other programs (0001).
- Request log lines for failed requests carry the reason, and browser tabs send reports to the log (0003).
- The browser is asked to keep the site's storage, and up to 100 MB of `.obsidian` files are kept between visits
  (0004).
- The browser bundles are minified (0005).
- Requests under `/relay/` are answered by the relay route: 404 for an invalid service name, 403 for another site's
  `Origin`, otherwise 503 (0006).

## Pages

| Page | What it covers |
| --- | --- |
| [0001-local-plugins-guard.md](0001-local-plugins-guard.md) … [0006-relay.md](0006-relay.md) | One page per patch: what it changes, why, files touched, configuration, behaviour when not configured |
| [building.md](building.md) | Building, testing and running this fork |
| [updating.md](updating.md) | Moving the patches to a newer upstream release |

## Patch files

The same six changes are kept as patch files in Ignis Control's
[`patches/`](https://github.com/Gameboard-dev/ignis-control/tree/main/patches) folder, to apply with `git apply` to an
upstream clone.

## Links

- Upstream: [Nystik-gh/ignis](https://github.com/Nystik-gh/ignis)
- Upstream documentation: [ignis.thiefling.com/docs](https://ignis.thiefling.com/docs/)
- Ignis Control: [Gameboard-dev/ignis-control](https://github.com/Gameboard-dev/ignis-control)
