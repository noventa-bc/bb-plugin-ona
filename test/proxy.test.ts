import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";
import { filterHeaders, isAllowedRequest, isAllowedUpgrade, startDaemonProxy } from "../src/proxy.ts";

test("allows only daemon and installer routes", () => {
  for (const [method, url] of [
    ["GET", "/health"],
    ["GET", "/install.sh"],
    ["HEAD", "/install/bb-app.tgz"],
    ["GET", "/install/version"],
    ["POST", "/internal/threads/events"],
    ["GET", "/internal/plugins/x/host/abc"],
    ["POST", "/internal/hosts/enroll"],
  ]) assert.equal(isAllowedRequest(method!, url!), true, `${method} ${url}`);

  for (const [method, url] of [
    ["GET", "/"],
    ["GET", "/api/v1/projects"],
    ["POST", "/api/v1/threads"],
    ["GET", "/ws"],
    ["POST", "/install.sh"],
    ["POST", "/internal/hosts/enroll-key"],
    ["POST", "/internal/hosts/enroll-key/"],
    ["POST", "/internal/Hosts/Enroll-Key"],
    ["GET", "/internal/server-move/pending"],
    ["GET", "/internal/%2e%2e/api/v1/projects"],
    ["GET", "/internal/../api/v1/projects"],
    ["GET", "/internal//api"],
    ["GET", "//evil/internal/x"],
    ["GET", "http://127.0.0.1/internal/x"],
  ]) assert.equal(isAllowedRequest(method!, url!), false, `${method} ${url}`);

  assert.equal(isAllowedUpgrade("/internal/ws?sessionId=1"), true);
  assert.equal(isAllowedUpgrade("/ws"), false);
  assert.equal(isAllowedUpgrade("/ws/terminals/t1"), false);
});

test("strips identity and forwarding headers", () => {
  const out = filterHeaders(
    {
      authorization: "Bearer daemon",
      "x-bb-gate-auth": "machine",
      "x-bb-gate-machine-id": "m",
      "x-bb-plugin-token": "t",
      "x-forwarded-for": "1.2.3.4",
      forwarded: "for=1.2.3.4",
      "x-real-ip": "1.2.3.4",
      connection: "keep-alive",
      host: "devbox",
    },
    "127.0.0.1:9",
  );
  assert.deepEqual(out, { authorization: "Bearer daemon", host: "127.0.0.1:9" });
});

let target: http.Server;
let targetUrl: URL;
const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
const noop = { debug() {}, info() {}, warn() {}, error() {} };
// The agent sandbox blocks localhost; these tests run in CI and outside the sandbox.
const local = { skip: process.env.NONO_CAP_FILE ? "needs local ports, blocked in the agent sandbox" : false };

before(async () => {
  if (local.skip) return;
  target = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    res.end(`ok ${req.url}`);
  });
  target.on("upgrade", (req, socket) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    if (req.url?.includes("reject")) {
      // Like a rejected handshake that keeps the connection open: anything
      // the client sends next would reach bb unfiltered if the proxy spliced.
      socket.write("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
      socket.on("data", (data) => seen.push({ url: `raw:${String(data).split("\r\n")[0]}`, headers: {} }));
      return;
    }
    socket.end("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\nhello");
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  targetUrl = new URL(`http://127.0.0.1:${(target.address() as net.AddressInfo).port}`);
});
after(() => target?.close());

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (c) => (body += c)).on("end", () => resolve({ status: res.statusCode!, body }));
    }).on("error", reject);
  });
}

test("proxy forwards allowed routes and blocks the user API", local, async () => {
  const proxy = await startDaemonProxy(() => targetUrl, noop);
  try {
    seen.length = 0;
    assert.deepEqual(await get(proxy.port, "/api/v1/projects"), {
      status: 403,
      body: JSON.stringify({ code: "forbidden", message: "Not available through the Ona tunnel" }),
    });
    assert.equal((await get(proxy.port, "/internal/hosts/enroll-key")).status, 403);
    assert.equal(seen.length, 0, "blocked requests never reach bb");

    const ok = await get(proxy.port, "/internal/x?y=1", { "x-bb-gate-auth": "machine", authorization: "Bearer d" });
    assert.deepEqual(ok, { status: 200, body: "ok /internal/x?y=1" });
    assert.equal(seen[0]!.headers["x-bb-gate-auth"], undefined);
    assert.equal(seen[0]!.headers.authorization, "Bearer d");
  } finally {
    await proxy.close();
  }
});

function upgrade(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: websocket\r\nx-bb-gate-auth: machine\r\n\r\n`);
    });
    let data = "";
    socket.setEncoding("utf8").on("data", (c) => (data += c)).on("end", () => resolve(data)).on("error", reject);
  });
}

test("proxy upgrades only the daemon socket", local, async () => {
  const proxy = await startDaemonProxy(() => targetUrl, noop);
  try {
    seen.length = 0;
    assert.match(await upgrade(proxy.port, "/ws"), /^HTTP\/1\.1 403/);
    assert.match(await upgrade(proxy.port, "/ws/terminals/t1"), /^HTTP\/1\.1 403/);
    assert.equal(seen.length, 0);
    const reply = await upgrade(proxy.port, "/internal/ws?sessionId=1");
    assert.match(reply, /^HTTP\/1\.1 101[\s\S]*hello$/);
    assert.equal(seen[0]!.url, "/internal/ws?sessionId=1");
    assert.equal(seen[0]!.headers["x-bb-gate-auth"], undefined);
  } finally {
    await proxy.close();
  }
});

test("a rejected upgrade is closed, not spliced", local, async () => {
  const proxy = await startDaemonProxy(() => targetUrl, noop);
  try {
    seen.length = 0;
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () => {
        socket.write("GET /internal/ws?reject=1 HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n");
        setTimeout(() => {
          if (!socket.destroyed) socket.write("GET /api/v1/projects HTTP/1.1\r\nhost: x\r\n\r\n");
        }, 100);
      });
      let data = "";
      socket.setEncoding("utf8").on("data", (c) => (data += c)).on("close", () => resolve(data)).on("error", reject);
    });
    assert.match(reply, /^HTTP\/1\.1 401/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(seen.map((entry) => entry.url), ["/internal/ws?reject=1"]);
  } finally {
    await proxy.close();
  }
});
