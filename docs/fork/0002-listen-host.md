# Patch 0002: listen host

Commit `c436038`: "Let HOST choose the address the server listens on". [Back to the fork overview](README.md).

## What it changes

The server passes the environment variable `HOST` to `app.listen()` as the address to listen on. The start-up line
names that address: `[ignis] Server running on http://<HOST>:<PORT>`.

## Why

Upstream listens on every network interface. Ignis Control runs Ignis and cloudflared in the same sandbox, and only
cloudflared needs to reach Ignis. Listening on `127.0.0.1` keeps the server off the local network.

## Files touched

| File | Change |
| --- | --- |
| `apps/ignis-server/server/index.js` | `app.listen(config.port, process.env.HOST \|\| undefined, …)` and the start-up line |

## Configuration

| Variable | Value | Default |
| --- | --- | --- |
| `HOST` | An IP address or host name to listen on, for example `127.0.0.1` | unset |

Ignis Control's launcher sets `HOST=127.0.0.1`.

## Behaviour when not configured

`HOST` unset or empty: the server listens on every interface, as upstream does, and the start-up line says
`http://localhost:<PORT>`.
