const express = require("express");
const path = require("path");
const compression = require("compression");
const config = require("./config");
const settings = require("./settings");
const { cacheControlFor } = require("./static/cache-headers");
const { buildIndexHtml } = require("./static/index-html");
const { getObsidianTerms } = require("./static/obsidian-terms");
const {
  setupWebSocket,
  watcher,
  writeCoalescer,
  resolveVaultPath,
  requestContext,
} = require("@ignis/server-core");
const {
  BRIDGE_PLUGIN_ID,
  migratePluginsFromAllVaults,
} = require("./plugin-system/migrate-bridge");
const {
  initPlugins,
  shutdownPlugins,
  getBundledPluginDirs,
  getPluginDataDir,
} = require("./plugin-system/manager");
const obCli = require("./obsidian-account/ob-cli");
const pluginRoutes = require("./routes/plugins");
const { flushAll } = writeCoalescer;

writeCoalescer.configure({ writeCoalesceMs: settings.get("writeCoalesceMs") });
watcher.configure({ ignoredPaths: settings.resolveIgnoreLines() });
obCli.init({
  obHome: path.join(
    getPluginDataDir(config.dataRoot, "headless-sync"),
    "ob-home",
  ),
});

const REPO_ROOT = path.join(__dirname, "..", "..", "..");

const ANSI_RED = "\x1b[31m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_RESET = "\x1b[0m";

const app = express();

// Reject oversized requests by Content-Length before parsing.
app.use((req, res, next) => {
  const declared = Number(req.headers["content-length"]);

  if (Number.isFinite(declared) && declared > settings.get("maxBodyBytes")) {
    return res.status(413).json({ error: "Request body too large" });
  }

  next();
});

app.use(express.json({ limit: settings.MAX_BODY_BACKSTOP }));
app.use(compression());

// logger middleware
//
// Local patch (Ignis Control, 2026-10-27; patches/0003-diagnostics.patch): a failed request is logged with its
// reason (the error's code and message, recorded by sanitizeError in requestContext, or the JSON error the route
// sent) and its full, decoded path; batch-read lists the files it skipped and why. LOG_REQUESTS=errors logs only
// failures, partial batch-reads and requests slower than SLOW_MS; NO_COLOR=1 leaves out the colour codes.
const LOG_ERRORS_ONLY = process.env.LOG_REQUESTS === "errors";
const PLAIN = Boolean(process.env.NO_COLOR);
const SLOW_MS = 2000;

function readableUrl(url) {
  try {
    return decodeURIComponent(url.replace(/\+/g, " "));
  } catch {
    return url;
  }
}

function oneLine(s, max = 300) {
  const t = String(s).replace(/\p{Cc}+/gu, " "); // control characters: one event, one line
  return t.length > max ? t.slice(0, max) + "..." : t;
}

app.use((req, res, next) => {
  const start = Date.now();
  const origEnd = res.end;
  const origJson = res.json;
  const store = {};

  res.json = function (body) {
    if (res.statusCode >= 400 && body && typeof body === "object") {
      store.body = body;
    }

    return origJson.call(this, body);
  };

  res.end = function (...args) {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const skipped = store.skipped || [];
    const failed = status >= 400;

    if (!LOG_ERRORS_ONLY || failed || skipped.length || duration >= SLOW_MS) {
      const color = PLAIN ? "" : status >= 500 ? ANSI_RED : status >= 400 ? ANSI_YELLOW : ANSI_GREEN;
      const reset = PLAIN ? "" : ANSI_RESET;
      let line = `${color}${req.method} ${status}${reset} ${oneLine(readableUrl(req.originalUrl), failed ? 300 : 120)} (${duration}ms)`;

      if (failed) {
        const e = store.error;
        const message = e ? String(e.message || e) : "";
        const code = e ? e.code || e.name || "error" : "";
        const why = e
          ? message.startsWith(code) ? message : `${code}: ${message}`
          : store.body?.error || store.body?.message || "";

        if (why) {
          line += ` -- ${oneLine(why)}`;
        }
      }

      if (skipped.length) {
        line += ` -- skipped ${skipped.length}: ${oneLine(skipped.slice(0, 5).join(", "))}`;
      }

      console.log(line);
    }

    origEnd.apply(this, args);
  };

  requestContext.run(store, next);
});

// What browser tabs report about themselves (packages/shim/src/diagnostics.js, local patch 0003): one log line per
// event, "client <session> ...". Each tab's session is introduced once with its device; at most CLIENT_BUDGET events
// per session in CLIENT_WINDOW_MS are written, the rest counted.
const CLIENT_BUDGET = 400;
const CLIENT_WINDOW_MS = 5 * 60 * 1000;
const clientSessions = new Map(); // session -> { windowStart, count, dropped, last }
const NEW_SESSIONS_PER_MINUTE = 20;
const SESSIONS_KEPT = 500;
let newSessionTimes = [];
let lastRefusalLogged = 0;

app.post("/api/client-log", (req, res) => {
  const { session, device, events } = req.body || {};

  if (typeof session !== "string" || !/^[a-z0-9]{1,12}$/.test(session) || !Array.isArray(events)) {
    return res.status(400).json({ error: "expected { session, device, events: [] }" });
  }

  const now = Date.now();
  let s = clientSessions.get(session);

  if (!s) {
    // At most NEW_SESSIONS_PER_MINUTE new sessions a minute, and SESSIONS_KEPT in all: a client cannot flood the log
    // by making up new session ids (each one's own budget is below)
    newSessionTimes = newSessionTimes.filter((t) => now - t < 60000);

    for (const [id, old] of clientSessions) {
      if (now - old.last > 3600 * 1000) {
        clientSessions.delete(id); // quiet for an hour: forgotten
      }
    }

    if (newSessionTimes.length >= NEW_SESSIONS_PER_MINUTE || clientSessions.size >= SESSIONS_KEPT) {
      if (now - lastRefusalLogged > 60000) {
        lastRefusalLogged = now;
        console.log("client-log: too many new sessions; reports from new pages refused for now");
      }

      return res.status(429).end();
    }

    newSessionTimes.push(now);
    s = { windowStart: now, count: 0, dropped: 0, last: now };
    clientSessions.set(session, s);
    console.log(`client ${session}: new page on ${oneLine(device || "an unknown device", 160)}`);
  }

  s.last = now;

  if (now - s.windowStart > CLIENT_WINDOW_MS) {
    if (s.dropped) {
      console.log(`client ${session}: ${s.dropped} more events in the last ${CLIENT_WINDOW_MS / 60000} minutes were not logged`);
    }

    s.windowStart = now;
    s.count = 0;
    s.dropped = 0;
  }

  for (const e of events.slice(0, 100)) {
    if (s.count >= CLIENT_BUDGET) {
      s.dropped += 1;
      continue;
    }

    s.count += 1;
    const level = ["error", "warn", "info"].includes(e?.level) ? e.level.toUpperCase() : "INFO";
    const plugin = typeof e?.plugin === "string" && e.plugin ? ` [plugin ${oneLine(e.plugin, 60)}]` : "";
    const stack = typeof e?.stack === "string" && e.stack ? ` -- stack: ${oneLine(e.stack, 400)}` : "";
    const t = Number.isFinite(e?.t) ? ` +${e.t}s` : "";

    console.log(`client ${session}${t} ${level} ${oneLine(e?.kind || "event", 30)}${plugin}: ${oneLine(e?.msg || "", 600)}${stack}`);
  }

  res.status(204).end();
});

const fsRoutes = require("./routes/fs");
const vaultRoutes = require("./routes/vault");
const proxyRoutes = require("./routes/proxy");
const versionRoutes = require("./routes/version");
const settingsRoutes = require("./routes/settings");
const bootstrapRoutes = require("./routes/bootstrap");
const bootstrapCache = require("./cache");
const treeReconcile = require("./cache/reconcile");
const { createMetadataChannel } = require("./cache/metadata-channel");
const { registerCacheListeners } = require("./cache/listeners");
const vaultLifecycle = require("./vault/lifecycle");

app.use("/assets", express.static(path.join(__dirname, "assets")));

app.use("/api/fs", fsRoutes);
app.use("/api/vault", vaultRoutes);
app.use("/api/proxy", proxyRoutes);
app.use("/api/version", versionRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/plugins", pluginRoutes);
app.use("/api/bootstrap", bootstrapRoutes);

// Serve vault files for resource URLs (images, attachments, etc.)
// Vault ID is the first path segment: /vault-files/<vault-id>/path/to/file
app.use("/vault-files", (req, res, next) => {
  // Extract vault ID from the first path segment
  const parts = req.path.split("/").filter(Boolean);

  if (parts.length === 0) {
    return res.status(400).json({ error: "Missing vault ID" });
  }

  const vaultId = decodeURIComponent(parts[0]);
  const vaultPath = config.getVaultPath(vaultId);

  if (!vaultPath) {
    return res.status(404).json({ error: "Vault not found" });
  }

  let resolved = null;

  try {
    const relPath = parts.slice(1).map(decodeURIComponent).join("/");
    resolved = relPath ? resolveVaultPath(vaultPath, relPath) : null;
  } catch {
    // resolved stays null and gets handled by static handler
  }

  const buffered = resolved ? writeCoalescer.getPending(resolved) : null;

  // Serve buffered content if exists.
  if (buffered) {
    const body = writeCoalescer.pendingBuffer(buffered.data, buffered.encoding);

    const ext = path.extname(resolved);

    if (ext) {
      res.type(ext);
    }

    return res.send(body);
  }

  // Rewrite req.url to strip the vault ID prefix, then serve statically
  req.url = "/" + parts.slice(1).join("/");
  express.static(vaultPath)(req, res, next);
});

app.get(["/", "/index.html"], (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "no-cache");
  res.send(buildIndexHtml());
});

app.get("/favicon.png", (req, res) => {
  res.sendFile(path.join(REPO_ROOT, "images", "favicon.png"));
});

// Cache headers for static assets, by version query.
// Set before express.static, which only fills Cache-Control when it is not already present.
app.use((req, res, next) => {
  const cacheControl = cacheControlFor(req.path, !!req.query.v);

  if (cacheControl) {
    res.setHeader("Cache-Control", cacheControl);
  }

  next();
});

app.use(express.static(path.join(REPO_ROOT, "packages", "ui", "dist")));
app.use(express.static(path.join(REPO_ROOT, "packages", "shim", "dist")));

app.use(express.static(config.obsidianAssetsPath));

// Local patch (Ignis Control, 2026-10-23; patches/0002-listen-host.patch): HOST picks the address to listen on,
// e.g. 127.0.0.1 so only this machine can connect. Unset, Ignis listens on every interface, as upstream does.
const server = app.listen(config.port, process.env.HOST || undefined, async () => {
  console.log(`[ignis] Server running on http://${process.env.HOST || "localhost"}:${config.port}`);
  console.log(`[ignis] Vault root: ${config.vaultRoot}`);
  console.log(`[ignis] Vaults: ${Object.keys(config.vaults).join(", ")}`);

  getObsidianTerms();

  await initPlugins({ app, config, wss, watcher });

  const bundledPluginDirs = getBundledPluginDirs();

  for (const { distDir } of bundledPluginDirs) {
    app.use(express.static(distDir));
  }

  await migratePluginsFromAllVaults(config.vaultRoot, [
    BRIDGE_PLUGIN_ID,
    ...bundledPluginDirs.map((d) => d.bundledPluginId),
  ]);

  bootstrapCache
    .warmUp()
    .catch((e) => console.warn("[bootstrap] warm-up error:", e.message));
});

const wss = setupWebSocket(server, {
  getVaultPath: config.getVaultPath,
  originAllowlist: settings.get("wsOrigins"),
});
vaultLifecycle.setWss(wss);

const metadataChannel = createMetadataChannel(wss);

registerCacheListeners({
  bootstrapCache,
  metadataChannel,
  watcher,
  writeCoalescer,
});

watcher.onWatcherStart((vaultId) => {
  bootstrapCache.markForRevalidation(vaultId);
  treeReconcile.startSchedule(vaultId);
});

bootstrapCache.onStaleEntryServed((vaultId) =>
  treeReconcile.scheduleReconcile(vaultId),
);

// Per-client listeners die along with their watcher.
watcher.onWatcherRebuild((vaultId) => {
  // force revalidation to ensure any missed changes are picked up
  bootstrapCache.invalidateVault(vaultId);
  wss.closeVaultSockets(vaultId);
});

writeCoalescer.onFlushGiveUp((absPath) => {
  const match = config.vaultForPath(absPath);

  if (!match) {
    return;
  }

  wss.broadcastToVault(match.vaultId, {
    type: "write-giveup",
    path: match.relPath,
  });
});

async function gracefulShutdown(signal) {
  console.log(`\n[ignis] Received ${signal}, shutting down gracefully...`);

  await flushAll();
  await shutdownPlugins();

  server.close(() => {
    console.log("[ignis] Server closed");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("[ignis] Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
