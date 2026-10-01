/* The whole service: the game page, its maps, Discord login and the relay,
   on one origin. */

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import { Auth, requestSession } from "./auth.ts";
import type { Config } from "./config.ts";
import type { DiscordApi } from "./discord.ts";
import {
  BUILD_PATTERN,
  CloseCode,
  IDENTIFIER_PATTERN,
  MAXIMUM_BATCH_BYTES,
  ROOM_ID_PATTERN,
  parseSocketQuery,
} from "./protocol.ts";
import { consoleLog, type Log, Relay } from "./relay.ts";
import { buildFile, type Context, hostedPage, isolationHeaders, mapFile, serveFile } from "./static.ts";
import { verifyToken } from "./tokens.ts";

export const AUTH_DEADLINE_MILLISECONDS = 5000;
export const HEARTBEAT_MILLISECONDS = 30_000;

export interface App {
  server: Server;
  relay: Relay;
  sockets: WebSocketServer;
}

/* "/activity/..." serves the same site for the Discord Activity's proxy. */
function splitContext(pathname: string): { context: Context; path: string } {
  if (pathname === "/activity" || pathname.startsWith("/activity/")) {
    return { context: "activity", path: pathname.slice("/activity".length) || "/" };
  }
  return { context: "page", path: pathname };
}

export function createApp(config: Config, discord: DiscordApi | null, log: Log = consoleLog,
    authDeadlineMilliseconds = AUTH_DEADLINE_MILLISECONDS, heartbeatMilliseconds = HEARTBEAT_MILLISECONDS): App {
  const auth = new Auth(config, discord);
  const relay = new Relay(config.maxRooms, log);
  const origins = new Set([config.publicOrigin, ...config.extraOrigins]);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    const { context, path } = splitContext(url.pathname);
    const headers = isolationHeaders(context);
    try {
      if (path === "/healthz") {
        response.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
        return;
      }
      if (await auth.handle(request, response, new URL(path + url.search, url))) return;
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
      }
      /* "/" serves the page itself rather than redirecting: behind the Discord
         Activity proxy the browser's path differs from this server's (the
         proxy adds /activity), so only relative URLs are correct in both. */
      const relative = path === "/" ? "halo.html" : decodeURIComponent(path.slice(1));
      const map = mapFile(relative);
      if (map) {
        if (!requestSession(config, request)) {
          response.writeHead(401, { ...headers, "Content-Type": "text/plain" }).end("login required");
          return;
        }
        await serveFile(request, response, config.mapsDir, map, "application/octet-stream",
          { ...headers, "Cache-Control": "private, max-age=3600" }, true);
        return;
      }
      const build = buildFile(relative);
      if (build?.file === "halo.html") {
        let source: string;
        try {
          source = await readFile(join(config.buildDir, build.file), "utf8");
        } catch {
          response.writeHead(404, { ...headers, "Content-Type": "text/plain" }).end("not found");
          return;
        }
        const page = Buffer.from(hostedPage(source));
        response.writeHead(200, { ...headers, "Content-Type": build.type, "Cache-Control": "no-cache",
          "Content-Length": String(page.length) });
        response.end(request.method === "HEAD" ? undefined : page);
        return;
      }
      if (build) {
        await serveFile(request, response, config.buildDir, build.file, build.type,
          { ...headers, "Cache-Control": "no-cache" }, false);
        return;
      }
      response.writeHead(404, { ...headers, "Content-Type": "text/plain" }).end("not found");
    } catch (error) {
      if (!response.headersSent) response.writeHead(400, { "Content-Type": "text/plain" }).end("bad request");
      else response.destroy();
      if (!(error instanceof URIError)) log({ event: "http-error", message: (error as Error).message });
    }
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAXIMUM_BATCH_BYTES });
  server.on("upgrade", (request: IncomingMessage, stream: Duplex, head: Buffer) => {
    const reject = (status: number, message: string) => {
      stream.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    const match = /^\/v1\/rooms\/([^/]+)\/ws$/.exec(splitContext(url.pathname).path);
    if (!match) return reject(404, "Not Found");
    const roomId = match[1]!;
    const query = parseSocketQuery(url);
    if (!ROOM_ID_PATTERN.test(roomId) || !query) return reject(400, "Bad Request");
    if (!origins.has(request.headers.origin ?? "")) return reject(403, "Forbidden");
    sockets.handleUpgrade(request, stream, head, (socket) => {
      watch(socket);
      authenticate(socket, roomId, query);
    });
  });

  /* Browsers cannot set headers on a WebSocket, so the token arrives in the
     first message: {type: "auth", token, id, build}. */
  function authenticate(socket: WebSocket, roomId: string, query: NonNullable<ReturnType<typeof parseSocketQuery>>) {
    const deadline = setTimeout(() => socket.close(CloseCode.Unauthorized, "authentication timed out"),
      authDeadlineMilliseconds);
    socket.once("close", () => clearTimeout(deadline));
    socket.once("message", (data, isBinary) => {
      clearTimeout(deadline);
      let message: { type?: unknown; token?: unknown; id?: unknown; build?: unknown } | null = null;
      if (!isBinary) {
        try {
          message = JSON.parse(data.toString());
        } catch {
          message = null;
        }
      }
      const session = message?.type === "auth" ? verifyToken(config.tokenSecret, message.token) : null;
      if (!session || typeof message?.id !== "string" || !IDENTIFIER_PATTERN.test(message.id) ||
          typeof message.build !== "string" || !BUILD_PATTERN.test(message.build)) {
        log({ event: "unauthorized", room: roomId.slice(0, 8), user: session?.sub ?? null });
        socket.close(CloseCode.Unauthorized, "unauthorized");
        return;
      }
      relay.join(socket, roomId, {
        user: session.sub, name: session.name, id: message.id, role: query.role, kind: query.kind,
      }, message.build);
    });
  }

  /* Protocol pings keep idle sockets open through proxies that close quiet
     WebSockets (Cloudflare: 100 s) and find peers that vanished without a
     close; browsers answer them without page code. */
  const alive = new WeakSet<WebSocket>();
  function watch(socket: WebSocket): void {
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
  }
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!alive.delete(socket)) {
        socket.terminate();
        continue;
      }
      socket.ping();
    }
  }, heartbeatMilliseconds);
  heartbeat.unref();
  server.on("close", () => clearInterval(heartbeat));

  return { server, relay, sockets };
}
