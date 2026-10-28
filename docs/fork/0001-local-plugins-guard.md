# Patch 0001: local plugins guard

Commit `a0d29c2`: "Keep listed plugins off in Ignis, follow desktop's plugin switches live, and keep Ignis's own
workspace". [Back to the fork overview](README.md).

## What it changes

A new guard in the browser shim, set up with Ignis's other guards, does three things:

1. **Plugins kept off in Ignis.** When a tab loads, it reads `.obsidian/ignis-disabled-plugins.json`, a JSON array of
   plugin ids (the `id` in each plugin's `manifest.json`).
   - Reads of `.obsidian/community-plugins.json` return the list without those ids, so Obsidian in the tab does not
     load them.
   - Writes of `community-plugins.json` from the tab add back the listed ids that the file on disk has, so switching a
     plugin on or off in Ignis never switches a listed plugin off for desktop Obsidian.
2. **Desktop's plugin switches followed live.** The guard watches `.obsidian/`. When `community-plugins.json` changes
   on disk (written by another program, such as desktop Obsidian), it waits 500 ms, reads the list again, loads the
   manifests of plugins installed since the tab loaded, and switches plugins on or off in the tab to match. Changes
   made by the tab itself are not echoed back.
3. **Ignis's own layout.** While no named workspace is in use (no `?workspace=` parameter, and no active workspace
   from Obsidian's Workspaces core plugin), `.obsidian/workspace.json` is read and written as
   `.obsidian/workspace-ignis.json`.

## Why

Ignis serves the same `.obsidian` folder that desktop Obsidian uses on the same machine.

- Two kinds of plugin must not run in a browser tab: a two-way sync plugin would sync the same files a second time,
  and a plugin that needs desktop features fails. Switching them off in Ignis with Obsidian's own switch would also switch
  them off on desktop, because both read the same `community-plugins.json`.
- Obsidian reads `community-plugins.json` only at start-up. Without the watcher, an open tab keeps its old set of
  plugins until it is reloaded.
- Desktop Obsidian and a browser tab overwrite each other's `workspace.json`, so each would open with the other's
  tabs and panes.

## Files touched

| File | Change |
| --- | --- |
| `packages/shim/src/guards/local-plugins-guard.js` | New: the guard (path resolver, read and write transforms, watcher) |
| `packages/shim/src/init.js` | Calls `initLocalPluginsGuard()` with the other guards |

Patch 0003 later moves the guard's set-up earlier, before Obsidian can start, and adds reports of what it did.

## Configuration

| Item | Format | Default | Read |
| --- | --- | --- | --- |
| `.obsidian/ignis-disabled-plugins.json` in the vault | JSON array of plugin ids, for example `["obsidian-git", "ignis-control"]` | none | When a tab loads |

After editing the file, reload the tab. Ignis Control's **Plugin exclusions** setting edits this file.

## Behaviour when not configured

- No `ignis-disabled-plugins.json`, an empty array, or a file that is not a JSON array: no plugin is kept off. Every
  plugin switched on for desktop also loads in Ignis. With patch 0003, the tab reports the reason to the server's log.
- The live following of `community-plugins.json` and the separate `workspace-ignis.json` are always active.
- A tab with a named workspace (`?workspace=<name>`, or an active workspace) uses upstream's named-workspace
  handling, not `workspace-ignis.json`.
