// local patch 0006: the same-origin relay to services on the computer that runs Ignis.
//
// A plugin in the browser asks `<this page's origin>/relay/<service>/<path>`; this route streams the request, and the
// answer (server-sent events too), through the named pipe the launcher (ignis/ignis_native.py) serves outside the
// sandbox, whose name it passes in IGNIS_LOCAL_RELAY. The launcher decides, per service, which requests may pass and
// which local port answers them (ignis/SETUP.md, "The relay"); this side only checks the form of the request.
// Same origin: no CORS, and Cloudflare Access's session covers it. A cross-site page cannot use it: a request with an
// Origin header must come from this host or from WS_ORIGINS. Cookies and credentials are not forwarded.

const http = require("http");

const SERVICE = /^[a-z][a-z0-9-]{0,31}$/;
// headers a local service needs; everything else (cookies, Cloudflare Access's tokens, forwarding headers) stays here
const FORWARDED = new Set(["accept", "accept-language", "content-type", "content-length", "last-event-id", "cache-control", "user-agent"]);
// the LaTeX build alone gets Cloudflare Access's token, which the launcher verifies before it builds (2026-10-28)
const TOKEN_FOR = new Set(["latex"]);

function forwardedHeaders(headers, service = "") {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (FORWARDED.has(key) || (key === "cf-access-jwt-assertion" && TOKEN_FOR.has(service))) out[key] = v;
  }
  out.host = "relay";
  out.connection = "close";
  return out;
}

// Whether the request came from this page (no Origin: a same-origin GET, or not a browser) or an allowed origin.
function originAllowed(req, allowlist) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    if (new URL(origin).host === req.headers.host) return true;
  } catch {
    return false;
  }
  return (allowlist || []).includes(origin);
}

function localRelay({ pipe = process.env.IGNIS_LOCAL_RELAY || "", originAllowlist = [] } = {}) {
  return (req, res) => {
    // req.url is relative to the mount point: "/quarry/health?x=1"
    const [first, ...rest] = req.url.replace(/^\/+/, "").split("/");
    const service = first || "";
    if (!SERVICE.test(service)) {
      return res.status(404).json({ error: "no such relay service" });
    }
    if (!originAllowed(req, originAllowlist)) {
      console.warn(`relay: refused ${req.method} /relay/${service}: origin ${req.headers.origin}`);
      return res.status(403).json({ error: "the relay serves only this page" });
    }
    if (!pipe) {
      return res.status(503).json({ error: "the relay is off: the launcher did not set IGNIS_LOCAL_RELAY" });
    }
    const upstream = http.request(
      { socketPath: pipe, method: req.method, path: `/${service}/${rest.join("/")}`, headers: forwardedHeaders(req.headers, service), agent: false },
      (up) => {
        const headers = { ...up.headers };
        delete headers.connection;
        res.writeHead(up.statusCode || 502, headers);
        if (typeof res.flushHeaders === "function") res.flushHeaders(); // an event stream starts at once
        up.pipe(res);
      },
    );
    upstream.on("error", (e) => {
      if (!res.headersSent) {
        res.status(502).json({ error: `the relay is not running (${e.code || e.message}): is the launcher up?` });
      } else {
        res.end();
      }
    });
    // the page went away (an EventSource closed): stop the request on the other side too
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  };
}

module.exports = { localRelay, forwardedHeaders, originAllowed };
