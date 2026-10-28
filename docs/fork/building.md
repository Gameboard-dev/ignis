# Building and running the fork

[Back to the fork overview](README.md).

The fork builds and runs as upstream does. Upstream's own deployment guide, including Docker, is at
[ignis.thiefling.com/docs/server/deploy](https://ignis.thiefling.com/docs/server/deploy/). This page covers running it
from source, which is how Ignis Control uses it.

## Requirements

| What | Notes |
| --- | --- |
| Node.js and npm | Upstream's container image uses Node 22 (`node:22-slim`). Ignis Control runs it with Node 24 |
| Git | To clone the repository |
| Obsidian's app files | The version in the release tag (`+obsidian.1.14.4`), with a `.obsidian-version` file |

## Build

```
git clone https://github.com/Gameboard-dev/ignis.git
cd ignis
npm ci
npm run build
```

`npm run build` writes the served bundles to `packages/*/dist/` and readable copies to `packages/*/reference/`
(patch 0005).

## Test and lint

```
npm test
npm run lint
```

`npm test` runs every Vitest test, including the fork's:

| Test file | Patch |
| --- | --- |
| `packages/shim/src/diagnostics.test.js` | 0003 |
| `packages/shim/src/fs/persistent-cache.test.js` | 0004 |
| `apps/ignis-server/server/routes/local-relay.test.mjs` | 0006 |

To run one file: `npx vitest run apps/ignis-server/server/routes/local-relay.test.mjs`.

## Obsidian's app files

Ignis serves Obsidian's own app files, which are not in this repository.

1. Download `obsidian-1.14.4.asar.gz` from
   `https://github.com/obsidianmd/obsidian-releases/releases/download/v1.14.4/obsidian-1.14.4.asar.gz`.
2. Decompress it to `obsidian.asar` (for example with `gunzip`).
3. Extract it into an empty folder: `npx @electron/asar extract obsidian.asar <obsidian-app>`.
4. Write `1.14.4` into `<obsidian-app>/.obsidian-version`.

This is what upstream's container image does
([entrypoint.sh](https://github.com/Nystik-gh/ignis/blob/main/apps/ignis-server/scripts/entrypoint.sh)).

## Run

```
npm run dev:server
```

starts `node apps/ignis-server/server/index.js` on port 8080. `npm run dev` builds first, then starts the server.

Environment variables used by the fork, in addition to upstream's
([environment](https://ignis.thiefling.com/docs/server/environment/)):

| Variable | Patch | Example | Unset |
| --- | --- | --- | --- |
| `HOST` | 0002 | `127.0.0.1` | Listens on every interface |
| `LOG_REQUESTS` | 0003 | `errors` | Every request is logged |
| `NO_COLOR` | 0003 | `1` | Coloured log |
| `IGNIS_LOCAL_RELAY` | 0006 | `\\.\pipe\<name>` or `/run/<name>.sock` | `/relay/` answers 503 |

The upstream variables that point the server at its files are `VAULT_ROOT` (default `vaults/` in the repository),
`DATA_ROOT` (default `data/`), `OBSIDIAN_ASSETS_PATH` (default `investigation/obsidian_1.14.4_unpacked/` in the
repository) and `PORT` (default 8080). Set `OBSIDIAN_ASSETS_PATH` to the folder from the previous section.

Example, listening on this machine only:

```
HOST=127.0.0.1 PORT=8080 VAULT_ROOT=/srv/vaults DATA_ROOT=/srv/ignis-data \
OBSIDIAN_ASSETS_PATH=/srv/obsidian-app LOG_REQUESTS=errors node apps/ignis-server/server/index.js
```

Ignis has no login. Before exposing it to other machines, put authentication and HTTPS in front of it
([Remote access](https://ignis.thiefling.com/docs/security/remote-access/)). Ignis Control does this with Cloudflare
Access and a Cloudflare Tunnel, and runs the server in a Windows AppContainer
([Ignis Control installation](https://github.com/Gameboard-dev/ignis-control/blob/main/docs/installation.md)).
