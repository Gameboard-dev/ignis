import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "module";
import http from "node:http";

const require = createRequire(import.meta.url);
const express = require("express");
const { localRelay, forwardedHeaders } = require("./local-relay.js");

const servers = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function listen(server, at) {
  servers.push(server);
  return new Promise((resolve) => server.listen(at, resolve));
}

// the launcher's side: an HTTP server on a named pipe (a Unix socket elsewhere), recording what it was sent
async function fakeLauncher(handler) {
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\ignis-relay-test-${process.pid}-${Math.random().toString(36).slice(2)}` : `/tmp/ignis-relay-test-${process.pid}-${Date.now()}.sock`;
  const seen = [];
  await listen(http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res);
    });
  }), pipe);
  return { pipe, seen };
}

async function ignis(pipe) {
  const app = express();
  app.use("/relay", localRelay({ pipe, originAllowlist: ["https://allowed.example"] }));
  const server = http.createServer(app);
  await listen(server, 0);
  return `http://127.0.0.1:${server.address().port}`;
}

describe("local relay", () => {
  it("passes a request and its body through the pipe, without cookies", async () => {
    const { pipe, seen } = await fakeLauncher((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const base = await ignis(pipe);
    const r = await fetch(`${base}/relay/quarry/search?x=1`, { method: "POST", headers: { "content-type": "application/json", cookie: "CF_Authorization=secret" }, body: '{"q":"a"}' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/quarry/search?x=1");
    expect(seen[0].body).toBe('{"q":"a"}');
    expect(seen[0].headers.cookie).toBeUndefined();
  });

  it("streams an event stream as it comes", async () => {
    const { pipe } = await fakeLauncher((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 200);
    });
    const base = await ignis(pipe);
    const r = await fetch(`${base}/relay/quarry/events`);
    const reader = r.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe("data: one\n\n"); // before the second part was written
    await reader.cancel();
  });

  it("refuses another site, a bad service name, and says when the relay is off", async () => {
    const { pipe, seen } = await fakeLauncher((req, res) => res.end("x"));
    const base = await ignis(pipe);
    expect((await fetch(`${base}/relay/quarry/health`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/relay/quarry/health`, { headers: { origin: "https://allowed.example" } })).status).toBe(200);
    expect((await fetch(`${base}/relay/..%2F/health`)).status).toBe(404);
    expect((await fetch(`${base}/relay/UPPER/health`)).status).toBe(404);
    expect(seen.length).toBe(1);
    const off = await ignis("");
    expect((await fetch(`${off}/relay/quarry/health`)).status).toBe(503);
  });

  it("says so when nothing serves the pipe", async () => {
    const base = await ignis(process.platform === "win32" ? "\\\\.\\pipe\\ignis-relay-test-nobody" : "/tmp/ignis-relay-test-nobody.sock");
    const r = await fetch(`${base}/relay/quarry/health`);
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/relay is not running/);
  });

  it("forwards only the headers a service needs", () => {
    expect(forwardedHeaders({ Cookie: "a", Authorization: "b", "cf-access-jwt-assertion": "c", "Content-Type": "x", "Last-Event-ID": "4" })).toEqual({ "content-type": "x", "last-event-id": "4", host: "relay", connection: "close" });
  });
});
