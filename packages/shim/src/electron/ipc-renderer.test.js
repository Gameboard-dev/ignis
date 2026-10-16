import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ipcRenderer } from "./ipc-renderer.js";

let proxied;

beforeEach(() => {
  proxied = [];

  globalThis.window = {
    location: { origin: "https://ignis.test" },
    __originalFetch: async (url, opts) => {
      proxied.push(JSON.parse(opts.body));

      return {
        ok: true,
        json: async () => ({ status: 200, headers: {}, body: "" }),
      };
    },
  };
});

afterEach(() => {
  delete globalThis.window;
  vi.restoreAllMocks();
});

function requestUrl(request) {
  return new Promise((resolve) => {
    ipcRenderer.once("req-1", (event, reply) => resolve(reply));
    ipcRenderer.send("request-url", "req-1", request);
  });
}

describe("the request-url log line", () => {
  it("names the channel without the request's headers or body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await requestUrl({
      url: "https://api.example.test/login",
      method: "POST",
      headers: { Authorization: "Bearer SECRET" },
      body: '{"password":"SECRET"}',
    });

    expect(log).toHaveBeenCalledWith("[shim:ipcRenderer] send:", "request-url");
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET");
  });
});
