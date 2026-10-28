const esbuild = require("esbuild");
const path = require("path");

const { version: semver } = require("../../package.json");

// Root build.js sets IGNIS_BUILD_RESOLVED when it runs first; standalone invocation falls back to a dev stamp.
const build = process.env.IGNIS_BUILD_RESOLVED || "dev";

// Local patch 0005 (Ignis Control): the served bundle is minified; a readable copy is written beside it for reference
// (reference/shim-loader.js; dist/ is what the server serves).
const options = {
  entryPoints: [path.join(__dirname, "src", "loader.js")],
  bundle: true,
  outfile: path.join(__dirname, "dist", "shim-loader.js"),
  format: "iife",
  platform: "browser",
  target: ["chrome90"],
  alias: {
    path: "path-browserify",
  },
  loader: {
    ".css": "text",
  },
  external: ["obsidian", "fs"],
  define: {
    __IGNIS_VERSION__: JSON.stringify(semver),
    __IGNIS_BUILD__: JSON.stringify(build),
  },
  logLevel: "info",
};

module.exports = Promise.all([
  // minified, so a phone downloads and parses less at every start
  esbuild.build({ ...options, minify: true }),
  esbuild.build({ ...options, outfile: path.join(__dirname, "reference", "shim-loader.js") }),
]);
