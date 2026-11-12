// Daemon-only proxy between the SSH reverse tunnel and the bb server.
//
// The bb server trusts loopback requests without credentials. A tunnel that
// pointed straight at its port would hand every process in a devbox the full
// user API (`/api/*`, app realtime, terminals). Instead the tunnel lands here,
// and only the routes a bb host daemon and its installer use are forwarded:
//
//   GET  /health, /install.sh, /install/version, /install/bb-app.tgz
//   the /internal routes in DAEMON_INTERNAL_ROUTES, by method and path
//        (bb requires daemon credentials on these)
//   WS   /internal/ws  (daemon socket; bb authenticates it)
//
// The WebSocket path is spliced only after bb answers 101; a rejected
// handshake is answered and closed, so it can't carry follow-up requests.
// Headers that could forge identity or origin (`x-bb-*`, `x-forwarded-*`,
// `forwarded`, `x-real-ip`) are stripped.
import http, { type IncomingHttpHeaders } from "node:http";
import net from "node:net";
import type { PluginLogger } from "@get-bb/plugin-sdk";

const PUBLIC_GET_PATHS = new Set(["/health", "/install.sh", "/install/version", "/install/bb-app.tgz"]);
/**
 * Method and path of the calls a bb host daemon makes under /internal (docs/ona-notes.md
 * says which bb version and where bb keeps them). A route bb adds later is blocked and
 * logged until it is listed here. Left out on purpose: `hosts/enroll-key`, which bb trusts
 * for any loopback caller, and `server-move/*`, since moving the bb server onto a devbox
 * through the tunnel is not supported.
 */
const DAEMON_INTERNAL_ROUTES = [
  "POST /internal/hosts/enroll",
  "POST /internal/session/open",
  "POST /internal/session/events",
  "POST /internal/session/tool-call",
  "POST /internal/session/interactive-request",
  "POST /internal/session/interactive-request/interrupt",
  "GET /internal/session/project-attachment-content",
  "GET /internal/plugins/:pluginId/host/:digest",
  "GET /internal/skills/tree/:hash",
  "POST /internal/skills/tree/:hash/content",
].map((route) => {
  const [method, path] = route.split(" ") as [string, string];
  return { method, segments: path.split("/") };
});

/** Segment by segment: a `:param` matches any one segment (`safePathname` leaves no empty ones), the rest exactly. */
function matchesRoute(segments: string[], pathname: string): boolean {
  const parts = pathname.split("/");
  return parts.length === segments.length && segments.every((s, i) => s.startsWith(":") || s === parts[i]);
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
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
  return DAEMON_INTERNAL_ROUTES.some((route) => route.method === method && matchesRoute(route.segments, pathname));
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

interface DaemonProxy {
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
      // Don't splice the sockets until bb accepts the upgrade. Otherwise a
      // rejected handshake (e.g. 401) could leave a raw, unfiltered HTTP
      // connection to bb that the devbox reuses for /api requests.
      let response = Buffer.alloc(0);
      const onHead = (chunk: Buffer) => {
        response = Buffer.concat([response, chunk]);
        const end = response.indexOf("\r\n\r\n");
        if (end === -1) {
          if (response.length > 16 * 1024) close();
          return;
        }
        upstream.off("data", onHead);
        if (!/^HTTP\/1\.[01] 101 /.test(response.subarray(0, end).toString("latin1"))) {
          // Forward only the response head, then close both sides.
          socket.end(response.subarray(0, end + 4));
          upstream.destroy();
          return;
        }
        socket.write(response);
        upstream.pipe(socket);
        socket.pipe(upstream);
      };
      upstream.on("data", onHead);
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
