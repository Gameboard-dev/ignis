# Patch 0005: startup

Commit `f832a88`: "Build the browser bundles minified, keeping readable copies outside what the server serves".
[Back to the fork overview](README.md).

## What it changes

- `npm run build` builds Ignis's two browser bundles minified:

  | Bundle | Served (minified) | Readable copy (not served) |
  | --- | --- | --- |
  | Shim | `packages/shim/dist/shim-loader.js` | `packages/shim/reference/shim-loader.js` |
  | UI | `packages/ui/dist/ignis-ui.js` | `packages/ui/reference/ignis-ui.js` |

- The page adds the class `is-ignis` to its `<html>` element at load, so a CSS snippet or a plugin can tell Ignis
  apart from desktop Obsidian.

## Why

Every tab downloads and parses both bundles at every start. Minified bundles are smaller and parse faster, which
matters most on a phone. The readable copies keep the built code inspectable.

## Files touched

| File | Change |
| --- | --- |
| `packages/shim/build.js` | Two builds: minified to `dist/`, readable to `reference/` |
| `packages/ui/build.js` | Two builds: minified to `dist/`, readable to `reference/` |
| `packages/shim/src/loader.js` | Adds the class `is-ignis` |

## Configuration

None.

## Behaviour when not configured

Always active. The `reference/` folders are not listed in `.gitignore`, so `git status` shows them as untracked after
a build.
