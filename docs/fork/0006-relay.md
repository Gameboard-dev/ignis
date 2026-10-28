# Patch 0006: relay

Commit `a0b469d`: "Add a same-origin relay to desktop services through a named pipe (IGNIS_LOCAL_RELAY)".
[Back to the fork overview](README.md).

## What it changes

A new route, `/relay/<service>/<path>`, passes a request from the page to a named pipe (a Unix socket on other
systems) and streams the answer back. The process serving the pipe decides what to do with each request.

```
plugin in the page ── /relay/<service>/<path> ──> Ignis server ── named pipe ──> process outside Ignis
                                                                  (IGNIS_LOCAL_RELAY)
```

| Step | Rule | Answer if it fails |
| --- | --- | --- |
| Service name | The first path segment matches `^[a-z][a-z0-9-]{0,31}$` | 404 `no such relay service` |
| Origin | No `Origin` header, an `Origin` whose host equals the request's `Host`, or an `Origin` listed in `WS_ORIGINS` | 403 `the relay serves only this page`; the server logs `relay: refused …` |
| Pipe set | `IGNIS_LOCAL_RELAY` is not empty | 503 `the relay is off: the launcher did not set IGNIS_LOCAL_RELAY` |
| Pipe served | A process answers on the pipe | 502 `the relay is not running (…): is the launcher up?` |

- **Path on the pipe:** `/<service>/<path>`, with the query string.
- **Request headers passed:** `accept`, `accept-language`, `content-type`, `content-length`, `last-event-id`,
  `cache-control`, `user-agent`. For the service `latex` only, also `cf-access-jwt-assertion` (Cloudflare Access's
  token). Cookies, `Authorization` and every other header are not passed. `Host` is set to `relay` and `Connection`
  to `close`.
- **Answer headers:** all of the pipe's answer headers except `Connection`. Headers are flushed at once, so a
  server-sent event stream starts without delay.
- **Streaming:** the request body and the answer stream in both directions. When the page closes the request, the
  request on the pipe is ended.
- **Order:** the route is mounted before Ignis's JSON body parser and compression, so bodies pass unread and answers
  are not buffered.

## Why

Plugins that use a service on the PC (a model server, a search service, a build) cannot reach it from a browser on
another device, and the sandbox Ignis Control runs Ignis in cannot connect to the PC's local services. A named pipe is
not subject to that sandbox's network isolation, and a process outside the sandbox can decide which requests reach
which service. Using the page's own origin means no CORS set-up and that the Cloudflare Access login covers the
requests.

## Files touched

| File | Change |
| --- | --- |
| `apps/ignis-server/server/routes/local-relay.js` | New: the route, the origin check and the header filter |
| `apps/ignis-server/server/routes/local-relay.test.mjs` | New: tests for passing, streaming, refusals and headers |
| `apps/ignis-server/server/index.js` | Mounts the route at `/relay` with `WS_ORIGINS` as the origin allowlist |

## Configuration

| Variable | Value | Default |
| --- | --- | --- |
| `IGNIS_LOCAL_RELAY` | The pipe's path, for example `\\.\pipe\zotsearch-ignis-relay` on Windows or a socket path elsewhere | unset |
| `WS_ORIGINS` (upstream) | Comma-separated origins. The relay also accepts requests with these origins | upstream's default (none) |

Ignis Control's launcher sets `IGNIS_LOCAL_RELAY=\\.\pipe\zotsearch-ignis-relay` and serves that pipe. The services it
passes and the requests it allows are documented in Ignis Control's
[relay.md](https://github.com/Gameboard-dev/ignis-control/blob/main/docs/relay.md).

## Behaviour when not configured

`IGNIS_LOCAL_RELAY` unset or empty: the route stays mounted. A request with an invalid service name gets 404, one from
another site's origin gets 403, and every other request gets 503. Nothing is forwarded.
