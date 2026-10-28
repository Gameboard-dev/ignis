// Local patch (Ignis Control, 2026-10-23; patches/ in the ignis-control repository): Ignis shares .obsidian with desktop
// Obsidian on the same machine, so two things are kept apart in the browser.
// 1. Community plugins listed in .obsidian/ignis-disabled-plugins.json (a JSON array of ids) stay off in Ignis while
//    desktop keeps running them: reads of community-plugins.json leave them out, and writes put back the ones the file
//    on disk has, so a plugin toggled in Ignis never switches them off on desktop.
// 2. The layout: with no ?workspace= in the URL, workspace.json is read and written as workspace-ignis.json, so the
//    browser and desktop Obsidian do not overwrite each other's open tabs and panes.
// 3. Plugins switched on or off on desktop follow in an open tab: when community-plugins.json changes on disk, the
//    running set is brought in line with it (new plugins' manifests are read first). Obsidian reads the file only at
//    start-up, so without this a tab would keep its old set until reloaded.

import {
  registerPathResolver,
  registerReadTransform,
  registerWriteTransform,
} from "../fs/transforms.js";
import { fsShim } from "../fs/index.js";
import { report } from "../diagnostics.js";

const LIST_PATH = ".obsidian/community-plugins.json";
const DISABLED_PATH = ".obsidian/ignis-disabled-plugins.json";
const WORKSPACE_PATH = ".obsidian/workspace.json";
const IGNIS_WORKSPACE_PATH = ".obsidian/workspace-ignis.json";

function parseIds(data) {
  try {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    const ids = JSON.parse(text);

    return Array.isArray(ids) ? ids : null;
  } catch {
    return null;
  }
}

function readIds(path) {
  try {
    return parseIds(fsShim.readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

// Bring the running plugins in line with community-plugins.json as this tab reads it (without the kept-off ones).
async function applyEnabledList() {
  const plugins = window.app?.plugins;

  if (!plugins || (typeof plugins.isEnabled === "function" && !plugins.isEnabled())) {
    return; // Obsidian not booted yet, or community plugins in restricted mode
  }

  const wanted = readIds(LIST_PATH);

  if (!wanted) {
    return;
  }

  if (wanted.some((id) => !plugins.manifests[id])) {
    await plugins.loadManifests(); // a plugin installed on desktop since this tab loaded
  }

  const want = new Set(wanted);

  for (const id of wanted) {
    if (!plugins.enabledPlugins.has(id) && plugins.manifests[id]) {
      console.log(`[ignis] Local plugins guard: switching on ${id} (switched on elsewhere)`);
      await plugins.enablePlugin(id);
    }
  }

  // A copy: disabling a plugin removes it from the set being iterated
  // oxlint-disable-next-line unicorn/no-useless-spread
  for (const id of [...plugins.enabledPlugins]) {
    if (!want.has(id)) {
      console.log(`[ignis] Local plugins guard: switching off ${id} (switched off elsewhere)`);
      await plugins.disablePlugin(id);
    }
  }
}

function followEnabledList() {
  let timer = null;

  // Changes made by this tab are not echoed back (Ignis's echo guard), so this sees only other writers.
  fsShim.watch(".obsidian", (eventType, filename) => {
    if (filename !== "community-plugins.json") {
      return;
    }

    clearTimeout(timer);
    timer = setTimeout(() => {
      applyEnabledList().catch((e) => console.error("[ignis] Local plugins guard:", e));
    }, 500);
  });
}

export function initLocalPluginsGuard() {
  registerPathResolver(
    (path) => path === WORKSPACE_PATH && !window.__workspaceName,
    () => IGNIS_WORKSPACE_PATH,
  );

  followEnabledList();

  // Local patch 0003: the guard says what it did (it used to fail silently when the list could not be read)
  let disabled = null;
  let why = "";

  try {
    disabled = parseIds(fsShim.readFileSync(DISABLED_PATH, "utf-8"));
    why = disabled ? "" : "not a JSON array of plugin ids";
  } catch (e) {
    why = `${e.code || e.name || "error"}: ${e.message || e}`;
  }

  if (!disabled || disabled.length === 0) {
    report("guard", why ? "error" : "info", why
      ? `${DISABLED_PATH} could not be used (${why}): every plugin switched on on desktop runs in this tab`
      : `${DISABLED_PATH} is empty: no plugin is kept off`);
    return;
  }

  report("guard", "info", `kept off in this tab: ${disabled.join(", ")}`);

  const off = new Set(disabled);
  // Set while the write transform reads the file as stored, so the read transform passes it through unfiltered.
  let raw = false;

  let told = false;

  registerReadTransform(LIST_PATH, (data) => {
    const ids = raw ? null : parseIds(data);

    if (ids && !told) {
      told = true;
      const removed = ids.filter((id) => off.has(id));
      report("guard", "info", `${LIST_PATH} read: ${ids.length} plugins switched on, ${removed.length} left out here`
        + (removed.length ? ` (${removed.join(", ")})` : ""));
    }

    return ids ? JSON.stringify(ids.filter((id) => !off.has(id)), null, 2) : data;
  });

  registerWriteTransform(LIST_PATH, (data) => {
    const ids = parseIds(data);

    if (!ids) {
      return data;
    }

    raw = true;
    let stored;

    try {
      stored = readIds(LIST_PATH) || [];
    } finally {
      raw = false;
    }

    const kept = stored.filter((id) => off.has(id) && !ids.includes(id));

    return JSON.stringify([...ids, ...kept], null, 2);
  });

  console.log(`[ignis] Local plugins guard: kept off in the browser: ${disabled.join(", ")}`);
}
