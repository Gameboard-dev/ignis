const esbuild = require("esbuild");
const sveltePlugin = require("esbuild-svelte");
const path = require("path");

// Local patch 0005 (Ignis Control): the served bundle is minified; a readable copy is written beside it for reference
// (reference/ignis-ui.js; dist/ is what the server serves).
const options = {
  entryPoints: [path.join(__dirname, "src", "index.js")],
  bundle: true,
  outfile: path.join(__dirname, "dist", "ignis-ui.js"),
  format: "iife",
  globalName: "IgnisUI",
  platform: "browser",
  target: ["chrome90"],
  mainFields: ["svelte", "browser", "module", "main"],
  conditions: ["svelte", "browser"],
  plugins: [sveltePlugin({ compilerOptions: { css: "injected" } })],
  logLevel: "info",
};

module.exports = Promise.all([
  // minified, so a phone downloads and parses less at every start
  esbuild.build({ ...options, minify: true }),
  esbuild.build({ ...options, outfile: path.join(__dirname, "reference", "ignis-ui.js") }),
]);
