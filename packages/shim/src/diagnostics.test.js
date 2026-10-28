import { describe, it, expect } from "vitest";
import { pluginOf } from "./diagnostics.js";

describe("pluginOf", () => {
  it("names the community plugin whose code is on a Chrome stack", () => {
    const stack = "TypeError: x is undefined\n    at e.onload (plugin:quarry:12:34)\n    at app.js:1:2";

    expect(pluginOf(stack)).toBe("quarry");
  });

  it("decodes an encoded plugin id and reads a Firefox stack", () => {
    expect(pluginOf("onload@plugin:my%20plugin:3:4\n@app.js:1:1")).toBe("my plugin");
  });

  it("names Ignis's own plugins", () => {
    expect(pluginOf("at load (https://x/ignis-virtual/ignis-bridge.js:5:6)")).toBe("ignis-bridge");
  });

  it("is empty for Obsidian or Ignis code", () => {
    expect(pluginOf("at e.load (app.js:1:2)")).toBe("");
    expect(pluginOf("")).toBe("");
  });
});
