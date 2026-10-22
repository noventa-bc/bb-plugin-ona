// Daemon-only proxy between the SSH reverse tunnel and the bb server.
//
// The bb server trusts loopback requests without credentials. A tunnel that
// pointed straight at its port would hand every process in a devbox the full
// user API (`/api/*`, app realtime, terminals). Instead the tunnel lands here,
// and only the routes a bb host daemon and its installer use are forwarded:
//
//   GET  /health, /install.sh, /install/version, /install/bb-app.tgz
//   ANY  /internal/*   (bb requires daemon credentials on these)
//   WS   /internal/ws  (daemon socket; bb authenticates it)
//
// Blocked inside /internal: `hosts/enroll-key` and `server-move/*`, which bb
// trusts for any loopback caller. Headers that could forge identity or origin
// (`x-bb-*`, `x-forwarded-*`, `forwarded`, `x-real-ip`) are stripped.
import http, { type IncomingHttpHeaders } from "node:http";
import net from "node:net";
import type { PluginLogger } from "@get-bb/plugin-sdk";

const PUBLIC_GET_PATHS = new Set(["/health", "/install.sh", "/install/version", "/install/bb-app.tgz"]);
const LOOPBACK_TRUSTED_INTERNAL = ["/internal/hosts/enroll-key", "/internal/server-move"];
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection",
]);

/** Returns the normalized pathname when the target is safe to inspect, else null. */
function safePathname(rawUrl: string): string | null {
  // Origin-form only ("/path?query"); no absolute or authority form.
  if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) return null;
  const pathname = rawUrl.split("?")[0]!;
  // Refuse anything a router might decode or normalize differently than us.
  if (/%|\\|\/\/|(^|\/)\.\.?(\/|$)/.test(pathname)) return null;
  return pathname.replace(/\/+$/, "") || "/";
}

export function isAllowedRequest(method: string, rawUrl: string): boolean {
  const pathname = safePathname(rawUrl);
  if (pathname === null) return false;
  if (PUBLIC_GET_PATHS.has(pathname)) return method === "GET" || method === "HEAD";
  if (!pathname.startsWith("/internal/")) return false;
  const lower = pathname.toLowerCase();
  return !LOOPBACK_TRUSTED_INTERNAL.some((blocked) => lower === blocked || lower.startsWith(`${blocked}/`));
}

export function isAllowedUpgrade(rawUrl: string): boolean {
  return safePathname(rawUrl) === "/internal/ws";
}

export function filterHeaders(headers: IncomingHttpHeaders, targetHost: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(key)) continue;
    if (key.startsWith("x-bb-") || key.startsWith("x-forwarded-") || key === "forwarded" || key === "x-real-ip") {
      continue;
    }
    out[key] = value;
  }
  out.host = targetHost;
  return out;
}

function deny(res: http.ServerResponse) {
  const body = JSON.stringify({ code: "forbidden", message: "Not available through the Ona tunnel" });
  res.writeHead(403, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export interface DaemonProxy {
  port: number;
  close(): Promise<void>;
}

/** Starts the proxy on an ephemeral 127.0.0.1 port. `target` is read per request. */
export function startDaemonProxy(target: () => URL, log: PluginLogger): Promise<DaemonProxy> {
  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "";
    if (!isAllowedRequest(method, rawUrl)) {
      log.warn(`ona proxy blocked ${method} ${rawUrl.split("?")[0]}`);
      deny(res);
      return;
    }
    const url = target();
    const upstream = http.request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path: rawUrl,
        headers: filterHeaders(req.headers, url.host),
      },
      (upstreamRes) => {
        const headers = { ...upstreamRes.headers };
        for (const key of HOP_BY_HOP) delete headers[key];
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req, socket, head) => {
    const rawUrl = req.url ?? "";
    if (req.method !== "GET" || !isAllowedUpgrade(rawUrl)) {
      log.warn(`ona proxy blocked upgrade ${rawUrl.split("?")[0]}`);
      socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const url = target();
    const upstream = net.connect(Number(url.port), url.hostname, () => {
      const headers = filterHeaders(req.headers, url.host);
      headers.connection = "Upgrade";
      headers.upgrade = String(req.headers.upgrade ?? "websocket");
      const lines = [`GET ${rawUrl} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", close);
    socket.on("error", close);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("proxy did not bind a TCP port"));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
