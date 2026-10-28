// Local patch (Ignis Control, 2026-10-27; patches/0003-diagnostics.patch in the ignis-control repository): what goes wrong in a
// browser tab reaches the server's log (ignis.log on the host), with the plugin that caused it, so a phone's problems
// can be read on the PC. Sent to POST /api/client-log in batches (navigator.sendBeacon: same origin, survives the
// page closing). Reported:
// - errors: uncaught exceptions, unhandled promise rejections, console.error and console.warn, each with the plugin
//   whose code is on the stack (Obsidian evaluates a plugin with "//# sourceURL=plugin:<id>"; Ignis's own plugins are
//   "ignis-virtual/<id>.js"), the first stack frames, and how often it repeated;
// - start-up: when the app object, the layout and the metadata index were ready, and each plugin's load time and
//   failure (app.plugins.loadPlugin wrapped);
// - stalls: Chrome's Long Animation Frames over STALL_MS, with the scripts (and so the plugins) that ran in them;
// - memory: every HEARTBEAT_MS, Chrome's JS heap (performance.memory: coarse, and refreshed only now and then unless
//   Chrome runs with --enable-precise-memory-info), each plugin's WebAssembly memory (outside the JS heap; wasm
//   instances are attributed to the plugin that created them), Ignis's note-content cache, and the element count;
// - crashes: the last heartbeat is kept in localStorage; a page that ended without "pagehide" (Chrome's "Aw, Snap!",
//   or Android killing the tab) is reported by the next page on the same device, with its last memory reading.
// On by default; switched off in Ignis Control's settings, which write SETTING_PATH ({"enabled": false}). The file is
// read once the vault is reachable (applyDiagnosticsSetting, from init.js); until then events are held, not sent.

import { fsShim } from "./fs/index.js";

const ENDPOINT = "/api/client-log";
const HEARTBEAT_MS = 5000;
const FLUSH_MS = 4000;
const STALL_MS = 300;
const MAX_TEXT = 600;
const MAX_FRAMES = 4;
const LAST_KEY = "ignis-diagnostics-last";
const SETTING_PATH = ".obsidian/ignis-diagnostics.json";

const session = Math.random().toString(36).slice(2, 8);
const t0 = performance.now();
let queue = [];
let flushTimer = null;
let enabled = null; // null: the setting not read yet (events are held); then true or false
let reporting = false; // set while this file reports, so its own console use is never reported again
const repeats = new Map(); // message key -> { count, event }
const wasmMemories = []; // { plugin, memory }

function seconds() {
  return Math.round(performance.now() - t0) / 1000;
}

function device() {
  const ua = navigator.userAgent;
  const os = /Android [\d.]+/.exec(ua)?.[0] || /iPhone OS [\d_]+/.exec(ua)?.[0] || /Windows NT [\d.]+/.exec(ua)?.[0]
    || /Mac OS X [\d_]+/.exec(ua)?.[0] || /Linux/.exec(ua)?.[0] || "unknown OS";
  const browser = /Firefox\/[\d.]+/.exec(ua)?.[0] || /Edg\/[\d.]+/.exec(ua)?.[0] || /Chrome\/[\d]+/.exec(ua)?.[0]
    || /Version\/[\d.]+ .*Safari/.exec(ua)?.[0] || "unknown browser";
  const mem = navigator.deviceMemory ? `, ${navigator.deviceMemory} GB` : "";

  return `${os}, ${browser}${mem}, ${window.innerWidth}x${window.innerHeight}`;
}

// The plugin whose code is on a stack (the first one found), or "" for Obsidian or Ignis itself.
export function pluginOf(stack) {
  if (!stack) {
    return "";
  }

  const m = /plugin:([^:\s)]+)/.exec(stack) || /ignis-virtual\/([^:\s)]+?)\.js/.exec(stack);

  return m ? decodeURIComponent(m[1]) : "";
}

function frames(stack) {
  if (!stack) {
    return "";
  }

  return stack.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at ") || l.includes("@"))
    .slice(0, MAX_FRAMES).join(" | ").slice(0, MAX_TEXT);
}

function text(value) {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// WebAssembly memories, by plugin: Rust plugins (Quarry, LaTeX, Augmented View ...) keep their data there, outside
// the JS heap Chrome reports.
function trackWasm() {
  const W = window.WebAssembly;

  if (!W) {
    return;
  }

  const note = (instance) => {
    const memory = instance?.exports?.memory;

    if (memory instanceof W.Memory) {
      wasmMemories.push({ plugin: pluginOf(new Error().stack || "") || "?", memory });
    }

    return instance;
  };

  W.Instance = new Proxy(W.Instance, { construct: (target, args) => note(Reflect.construct(target, args)) });

  const instantiate = W.instantiate;
  W.instantiate = function (...args) {
    const stack = new Error().stack || "";

    return instantiate.apply(this, args).then((r) => {
      const memory = (r.instance || r)?.exports?.memory;

      if (memory instanceof W.Memory) {
        wasmMemories.push({ plugin: pluginOf(stack) || "?", memory });
      }

      return r;
    });
  };
}

function wasm() {
  const byPlugin = {};

  for (const { plugin, memory } of wasmMemories) {
    byPlugin[plugin] = (byPlugin[plugin] || 0) + Math.round(memory.buffer.byteLength / 1048576);
  }

  return byPlugin;
}

function contentCacheMB() {
  const c = fsShim?._contentCache;

  return c ? Math.round((c._currentSize || 0) / 1048576) : null;
}

function heap() {
  const m = performance.memory; // Chrome only
  const mb = (b) => Math.round(b / 1048576);

  return m ? { usedMB: mb(m.usedJSHeapSize), totalMB: mb(m.totalJSHeapSize), limitMB: mb(m.jsHeapSizeLimit) } : null;
}

function send(events) {
  const body = JSON.stringify({ session, device: device(), events });

  try {
    if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }))) {
      return;
    }
  } catch {
    // fall through to fetch
  }

  (window.__originalFetch || fetch)(ENDPOINT, {
    method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true,
  }).catch(() => {});
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;

  if (enabled !== true) {
    return; // held until the setting is read, or off
  }

  for (const r of repeats.values()) {
    if (r.count > 1) {
      queue.push({ ...r.event, msg: `${r.event.msg} (repeated ${r.count - 1} more times)`, t: seconds() });
    }
  }

  repeats.clear();

  if (queue.length) {
    const events = queue;
    queue = [];
    send(events);
  }
}

// Queue an event; an identical one within the same batch is counted instead of sent again.
export function report(kind, level, msg, extra = {}) {
  if (reporting || enabled === false) {
    return;
  }

  reporting = true;

  try {
    const event = { t: seconds(), kind, level, msg: String(msg).slice(0, MAX_TEXT), ...extra };
    const key = `${kind}|${level}|${extra.plugin || ""}|${event.msg}`;
    const seen = repeats.get(key);

    if (seen) {
      seen.count += 1;
    } else {
      repeats.set(key, { count: 1, event });
      queue.push(event);
    }

    if (level === "error" || queue.length >= 25) {
      flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_MS);
    }
  } finally {
    reporting = false;
  }
}

function reportError(kind, error, fallback) {
  const stack = error?.stack || "";

  report(kind, "error", error ? text(error) : fallback, { plugin: pluginOf(stack), stack: frames(stack) });
}

function wrapConsole(level) {
  const original = console[level].bind(console);

  console[level] = (...args) => {
    original(...args);

    if (reporting) {
      return;
    }

    const err = args.find((a) => a instanceof Error);
    const stack = err?.stack || new Error().stack || "";
    const msg = args.map(text).join(" ");

    report("console", level === "error" ? "error" : "warn", msg, { plugin: pluginOf(stack), stack: frames(stack) });
  };
}

function lastPage() {
  try {
    const last = JSON.parse(localStorage.getItem(LAST_KEY) || "null");

    if (last && !last.closed) {
      const h = last.heap ? `, JS heap ${last.heap.usedMB} of ${last.heap.limitMB} MB` : "";
      const w = last.wasm && Object.keys(last.wasm).length
        ? `, WebAssembly ${Object.entries(last.wasm).map(([p, mb]) => `${p} ${mb} MB`).join(", ")}` : "";
      const c = last.cacheMB != null ? `, note cache ${last.cacheMB} MB` : "";
      report("crash", "error",
        `the previous page on this device (session ${last.session}, open ${last.uptime} s) ended without closing:`
        + ` a crash ("Aw, Snap!") or the tab killed by the system. Last reading ${Math.round((Date.now() - last.at) / 1000)} s`
        + ` ago${h}${w}${c}, ${last.elements} page elements, ${last.stage || "?"}, note "${last.note || "?"}"`,
        { previous: last.session });
    }
  } catch {
    // no storage (private window): nothing to compare with
  }
}

let stage = "starting"; // the last boot milestone reached, kept with the heartbeat

function heartbeat(closed = false) {
  if (enabled === false) {
    return { h: null, w: {}, cacheMB: null, elements: 0, note: "" };
  }

  const h = heap();
  const elements = document.getElementsByTagName("*").length;
  const note = window.app?.workspace?.getActiveFile?.()?.path || "";
  const w = wasm();
  const cacheMB = contentCacheMB();

  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({
      session, at: Date.now(), uptime: Math.round(seconds()), heap: h, wasm: w, cacheMB, elements, note, stage, closed,
    }));
  } catch {
    // storage full or blocked
  }

  return { h, w, cacheMB, elements, note };
}

function watchMemory() {
  let lastSent = 0;

  setInterval(() => {
    const { h, w, cacheMB, elements, note } = heartbeat();
    const used = h?.usedMB || 0;
    const wasmMB = Object.values(w).reduce((a, b) => a + b, 0);

    // Sent every 15 s for the first two minutes (start-up is when tabs have died), then once a minute; at once when
    // the heap passes 60% of its limit
    const high = h && used > 0.6 * h.limitMB;
    const every = seconds() < 120 ? 15000 : 60000;

    if (high || Date.now() - lastSent >= every) {
      lastSent = Date.now();
      const js = h ? `JS heap ${used} MB used, ${h.totalMB} MB reserved, limit ${h.limitMB} MB (coarse)` : "JS heap not reported";
      const wa = wasmMB ? `; WebAssembly ${wasmMB} MB (${Object.entries(w).map(([p, mb]) => `${p} ${mb}`).join(", ")})` : "";
      const ca = cacheMB != null ? `; note cache ${cacheMB} MB` : "";

      report("memory", high ? "warn" : "info", `${js}${wa}${ca}; ${elements} page elements; ${stage}; note "${note}"`,
        { heap: h, wasm: w, cacheMB, elements });
    }
  }, HEARTBEAT_MS);

  window.addEventListener("pagehide", () => {
    heartbeat(true);
    report("page", "info", "page closed or reloaded");
    flush();
  });
}

function watchStalls() {
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < STALL_MS) {
          continue;
        }

        const scripts = (e.scripts || []).filter((s) => s.duration > 50).sort((a, b) => b.duration - a.duration);
        const who = scripts.slice(0, 3).map((s) => {
          const p = pluginOf(s.sourceURL) || s.sourceURL.split("/").pop() || "?";

          return `${p} ${Math.round(s.duration)} ms (${s.invoker || s.invokerType || ""})`;
        });

        report("stall", "warn", `page frozen ${Math.round(e.duration)} ms${who.length ? `: ${who.join("; ")}` : ""}`,
          { plugin: pluginOf(scripts[0]?.sourceURL || "") });
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch {
    // not Chrome 123+: no stall reports
  }
}

function milestone(text) {
  stage = text;
  report("boot", "info", `${text} at ${seconds()} s`);
}

// app.plugins.loadPlugin, timed; and the boot milestones. The app object's parts (plugins, workspace, metadata cache)
// appear after the object itself, so each is taken up as soon as it exists (looked for every 50 ms for a minute).
function watchApp(app) {
  milestone("app object created");
  const pending = { plugins: wrapPlugins, workspace: watchLayout, metadataCache: watchIndex };
  const start = Date.now();
  const timer = setInterval(() => {
    for (const [part, take] of Object.entries(pending)) {
      if (app[part]) {
        delete pending[part];
        take(app);
      }
    }

    if (!Object.keys(pending).length || Date.now() - start > 60000) {
      clearInterval(timer);

      if (Object.keys(pending).length) {
        report("diagnostics", "warn", `not seen within a minute: app.${Object.keys(pending).join(", app.")}`);
      }
    }
  }, 50);
}

function wrapPlugins(app) {
  const plugins = app.plugins;
  const load = plugins.loadPlugin;

  if (typeof load === "function") {
    plugins.loadPlugin = async function (id, ...rest) {
      const start = performance.now();

      try {
        const p = await load.call(this, id, ...rest);
        const ms = Math.round(performance.now() - start);

        report("plugin", ms > 1000 ? "warn" : "info", `loaded ${id} in ${ms} ms${p ? "" : " (not loaded: disabled or missing)"}`,
          { plugin: id, ms });

        return p;
      } catch (e) {
        report("plugin", "error", `${id} failed to load after ${Math.round(performance.now() - start)} ms: ${text(e)}`,
          { plugin: id, stack: frames(e?.stack) });
        throw e;
      }
    };
  }
}

function watchLayout(app) {
  app.workspace.onLayoutReady?.(() => milestone("layout ready"));
}

function watchIndex(app) {
  const cache = app.metadataCache;

  if (cache.on) {
    const ref = cache.on("resolved", () => {
      cache.offref(ref);
      milestone(`metadata index complete (${app.vault.getMarkdownFiles().length} notes)`);
    });
  }
}

let watched = null;

function watchOnce(app) {
  if (app && watched !== app) {
    watched = app;
    watchApp(app);
  }
}

function awaitApp() {
  if (window.app) {
    watchOnce(window.app);
    return;
  }

  // Should the assignment below not be seen: look once a second for a minute (plugin timings would then be missed)
  let tries = 0;
  const fallback = setInterval(() => {
    if (watched || ++tries > 60) {
      clearInterval(fallback);
    } else if (window.app?.workspace) {
      report("diagnostics", "warn", "the app object was found late: plugin load times are not reported this time");
      watchOnce(window.app);
    }
  }, 1000);

  // Obsidian assigns window.app once; catch the assignment
  let value;

  try {
    Object.defineProperty(window, "app", {
      configurable: true,
      get: () => value,
      set: (v) => {
        Object.defineProperty(window, "app", { configurable: true, writable: true, value: v });
        value = v;
        try {
          watchOnce(v);
        } catch (e) {
          report("diagnostics", "warn", `could not watch the app: ${text(e)}`);
        }
      },
    });
  } catch {
    report("diagnostics", "warn", "could not watch the app object: no plugin timings");
  }
}

// Read the setting (Ignis Control writes it); a missing or unreadable file means on.
export function applyDiagnosticsSetting() {
  if (enabled !== null) {
    return;
  }

  let on = true;

  try {
    on = JSON.parse(fsShim.readFileSync(SETTING_PATH, "utf-8")).enabled !== false;
  } catch {
    // no file: the default, on
  }

  enabled = on;

  if (on) {
    flush();
  } else {
    queue = [];
    repeats.clear();

    try {
      localStorage.removeItem(LAST_KEY);
    } catch {
      // nothing stored
    }
  }
}

export function installDiagnostics() {
  setTimeout(applyDiagnosticsSetting, 30000); // the vault never became readable: the default, on
  window.addEventListener("error", (e) => reportError("uncaught", e.error, `${e.message} at ${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => reportError("unhandled rejection", e.reason instanceof Error
    ? e.reason : null, text(e.reason)));
  wrapConsole("error");
  wrapConsole("warn");
  trackWasm();
  lastPage();
  heartbeat();
  report("boot", "info", `page opened: ${location.pathname}${location.search}`);
  watchMemory();
  watchStalls();
  awaitApp();
}
