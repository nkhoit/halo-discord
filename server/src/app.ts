/* The whole service: the game page, its maps, Discord login and the relay,
   on one origin. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import { activityRoomId, Auth, clientAddress, requestSession } from "./auth.ts";
import type { Config } from "./config.ts";
import type { DiscordApi } from "./discord.ts";
import {
  BUILD_PATTERN,
  CloseCode,
  IDENTIFIER_PATTERN,
  instanceLocation,
  MAXIMUM_BATCH_BYTES,
  ROOM_ID_PATTERN,
  parseSocketQuery,
} from "./protocol.ts";
import { type Access, consoleLog, type Log, Relay } from "./relay.ts";
import { activityBundle } from "./bundle.ts";
import {
  ACTIVITY_CSP,
  buildFile,
  type Context,
  type AssetVersions,
  contentVersion,
  gameImage,
  HANDLERS_SCRIPT,
  hostedPage,
  ICONS,
  IMMUTABLE,
  isolationHeaders,
  LOGIN_SCRIPT,
  mapFile,
  NO_STORE,
  REVALIDATE,
  serveFile,
} from "./static.ts";
import { type Session, verifyToken } from "./tokens.ts";

export const AUTH_DEADLINE_MILLISECONDS = 5000;
export const HEARTBEAT_MILLISECONDS = 30_000;

export interface App {
  server: Server;
  relay: Relay;
  sockets: WebSocketServer;
}

/* Who a relay socket belongs to, for its log lines; known after authentication. */
interface SocketContext {
  room: string;
  user: string | null;
  id: string | null;
}

/* The Activity context: Discord launches an Activity by loading the mapped
   root with frame_id, instance_id and so on in the query; a URL mapping may
   also target the /activity prefix. */
function splitContext(url: URL): { context: Context; path: string } {
  const { pathname } = url;
  if (pathname === "/activity" || pathname.startsWith("/activity/")) {
    return { context: "activity", path: pathname.slice("/activity".length) || "/" };
  }
  if ((pathname === "/" || pathname === "/halo.html") && url.searchParams.has("frame_id")) {
    return { context: "activity", path: pathname };
  }
  return { context: "page", path: pathname };
}

const JAVASCRIPT = "text/javascript; charset=utf-8";
const NETSTATS_INTERVAL_MILLISECONDS = 2000;
const MAXIMUM_NETSTATS_BYTES = 16 * 1024;
const CLIENT_ERROR_INTERVAL_MILLISECONDS = 1000;
const MAXIMUM_CLIENT_ERRORS_PER_MINUTE = 60;
const MAXIMUM_CLIENT_ERROR_BYTES = 2048;

async function readSmallJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) return "too large";
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
const ICON_DIRECTORY = fileURLToPath(new URL("../icons/", import.meta.url));
const CLIENT_DIRECTORY = fileURLToPath(new URL("../client/", import.meta.url));
const HOSTED_FILES: Record<string, string> = { "hosted.js": JAVASCRIPT, "hosted.css": "text/css; charset=utf-8" };

function sendBody(request: IncomingMessage, response: ServerResponse, headers: Record<string, string>,
    type: string, body: string): void {
  const bytes = Buffer.from(body);
  response.writeHead(200, { ...headers, "Content-Type": type, "Content-Length": String(bytes.length) });
  response.end(request.method === "HEAD" ? undefined : bytes);
}

/* Map bytes are the same for every player, but only signed-in players may
   have them: "private" keeps every shared cache (Cloudflare's edge, Discord's
   proxy) from storing them, while the player's own browser may keep them for
   an hour, which spares the server's upload when a match restarts. */
const MAP_CACHE = { "Cache-Control": "private, max-age=3600", Vary: "Cookie, Authorization" };

export function createApp(config: Config, discord: DiscordApi | null, log: Log = consoleLog,
    authDeadlineMilliseconds = AUTH_DEADLINE_MILLISECONDS, heartbeatMilliseconds = HEARTBEAT_MILLISECONDS): App {
  const auth = new Auth(config, discord, log);
  const relay = new Relay(config.maxRooms, log);
  const origins = new Set([config.publicOrigin, ...config.extraOrigins]);
  /* Discord's proxy origin for this application's Activity. */
  if (config.discord) origins.add(`https://${config.discord.clientId}.discordsays.com`);
  const activityPage = {
    clientId: config.discord?.clientId ?? "development",
    publicOrigin: config.publicOrigin,
    dev: config.devLogin,
  };
  const iconVersions = Object.fromEntries(Object.keys(ICONS).map((name) =>
    [name, contentVersion(readFileSync(join(ICON_DIRECTORY, name)))]));
  const hosted = Object.fromEntries(Object.keys(HOSTED_FILES).map((name) => {
    const body = readFileSync(join(CLIENT_DIRECTORY, name), "utf8");
    return [name, { body, version: contentVersion(body) }];
  })) as Record<string, { body: string; version: string }>;
  const loginVersion = contentVersion(LOGIN_SCRIPT);

  /* The session's allowlisted Discord servers (as of sign-in, and still on
     the allowlist), and its Activity instance's room. */
  function guildsOf(session: Session): string[] {
    const allowlist = config.discord?.guildIds;
    return (session.guilds ?? []).filter((guild) => !allowlist || allowlist.includes(guild));
  }
  function ownRoomId(session: Session): string | null {
    return session.inst ? activityRoomId(config.tokenSecret, session.inst) : null;
  }
  function accessOf(session: Session, roomId: string): Access {
    const location = session.inst ? instanceLocation(session.inst) : null;
    return {
      own: ownRoomId(session) === roomId ? { guild: location?.guild ?? null, channel: location?.channel ?? null } : null,
      guilds: guildsOf(session),
      activity: session.inst !== undefined,
    };
  }
  const handlersVersion = contentVersion(HANDLERS_SCRIPT);

  async function source(): Promise<string | null> {
    try {
      return await readFile(join(config.buildDir, "halo.html"), "utf8");
    } catch {
      return null;
    }
  }

  /* halo.js and halo.wasm, hashed together; recomputed when either changes. */
  let app: { key: string; version: string } | null = null;
  async function appVersion(): Promise<string> {
    const files = ["halo.js", "halo.wasm"].map((name) => join(config.buildDir, name));
    const stats = await Promise.all(files.map((file) => stat(file).catch(() => null)));
    const key = stats.map((info) => info ? `${info.mtimeMs}:${info.size}` : "missing").join("|");
    if (app?.key !== key) {
      const hash = createHash("sha256");
      for (const file of files) hash.update(await readFile(file).catch(() => Buffer.alloc(0)));
      app = { key, version: hash.digest("hex").slice(0, 16) };
    }
    return app.version;
  }

  /* A page's measurement windows (library_web_transport.js netstatsSend),
     logged with the player's Discord ID: one a user every two seconds, small
     JSON objects only. Off unless NETSTATS_UPLOAD=1. */
  const netstatsLast = new Map<string, number>();
  async function receiveNetstats(request: IncomingMessage, response: ServerResponse,
      headers: Record<string, string>): Promise<void> {
    const reply = (status: number) => response.writeHead(status, headers).end();
    if (!config.netstatsUpload) return void reply(404);
    const session = requestSession(config, request);
    if (!session) return void reply(401);
    const now = Date.now();
    if (now - (netstatsLast.get(session.sub) ?? 0) < NETSTATS_INTERVAL_MILLISECONDS) return void reply(429);
    netstatsLast.set(session.sub, now);
    if (netstatsLast.size > 10_000) netstatsLast.clear();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAXIMUM_NETSTATS_BYTES) return void reply(413);
      chunks.push(chunk as Buffer);
    }
    let stats: unknown;
    try {
      stats = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return void reply(400);
    }
    if (!stats || typeof stats !== "object" || Array.isArray(stats)) return void reply(400);
    log({ event: "netstats", user: session.sub, stats });
    reply(204);
  }

  /* A page's errors (activity.js reportError), logged for diagnosing failures
     in players' Discord clients. Also before sign-in, so keyed by the user or
     else the address; small JSON objects only, and a global cap. */
  const clientErrorLast = new Map<string, number>();
  const clientErrorMinute = { start: 0, count: 0 };
  async function receiveClientError(request: IncomingMessage, response: ServerResponse,
      headers: Record<string, string>): Promise<void> {
    const reply = (status: number) => response.writeHead(status, headers).end();
    const session = requestSession(config, request);
    const key = session?.sub ?? clientAddress(config, request);
    const now = Date.now();
    if (now - clientErrorMinute.start >= 60_000) Object.assign(clientErrorMinute, { start: now, count: 0 });
    if (now - (clientErrorLast.get(key) ?? 0) < CLIENT_ERROR_INTERVAL_MILLISECONDS ||
        ++clientErrorMinute.count > MAXIMUM_CLIENT_ERRORS_PER_MINUTE) {
      return void reply(429);
    }
    clientErrorLast.set(key, now);
    if (clientErrorLast.size > 10_000) clientErrorLast.clear();
    const body = await readSmallJson(request, MAXIMUM_CLIENT_ERROR_BYTES);
    if (body === "too large") return void reply(413);
    if (!body || typeof body !== "object" || Array.isArray(body)) return void reply(400);
    log({ event: "client-error", user: session?.sub ?? null, error: body });
    reply(204);
  }

  async function versions(): Promise<AssetVersions> {
    return { app: await appVersion(), activity: contentVersion(await activityBundle()), icons: iconVersions,
      hostedScript: hosted["hosted.js"]!.version, hostedStyle: hosted["hosted.css"]!.version };
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    const { context, path } = splitContext(url);
    /* Nothing is cacheable unless a response below says so. */
    const headers: Record<string, string> = { ...isolationHeaders(context), "Cache-Control": NO_STORE };
    const requested = url.searchParams.get("v");
    const cache = (version: string) => ({ ...headers, "Cache-Control": requested === version ? IMMUTABLE : REVALIDATE });
    const notFound = () => response.writeHead(404, { ...headers, "Content-Type": "text/plain" }).end("not found");
    try {
      if (path === "/healthz") {
        response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": NO_STORE }).end("ok");
        return;
      }
      if (await auth.handle(request, response, new URL(path + url.search, url))) return;
      if (path === "/v1/netstats" && request.method === "POST") return receiveNetstats(request, response, headers);
      if (path === "/v1/client-errors" && request.method === "POST") return receiveClientError(request, response, headers);
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": NO_STORE }).end();
        return;
      }
      /* The other Activity rooms in the caller's Discord server, for its
         lobby; only from an Activity session in a server it belongs to. */
      if (path === "/v1/guild-rooms") {
        const session = requestSession(config, request);
        if (!session) {
          response.writeHead(401, { ...headers, "Content-Type": "text/plain" }).end("login required");
          return;
        }
        const guild = session.inst ? instanceLocation(session.inst)?.guild : undefined;
        const build = url.searchParams.get("build");
        const rooms = guild && guildsOf(session).includes(guild) ?
          relay.guildRooms(guild, ownRoomId(session), build && BUILD_PATTERN.test(build) ? build : null) : [];
        response.writeHead(200, { ...headers, "Content-Type": "application/json" }).end(JSON.stringify({ rooms }));
        return;
      }
      const room = /^\/v1\/rooms\/([^/]+)$/.exec(path);
      if (room) {
        if (!ROOM_ID_PATTERN.test(room[1]!)) return notFound();
        if (!requestSession(config, request)) {
          response.writeHead(401, { ...headers, "Content-Type": "text/plain" }).end("login required");
          return;
        }
        response.writeHead(200, { ...headers, "Content-Type": "application/json" })
          .end(JSON.stringify(relay.summary(room[1]!)));
        return;
      }
      /* "/" serves the page itself rather than redirecting, so every URL in
         it stays relative and works behind any proxy mapping. */
      const relative = path === "/" ? "halo.html" : decodeURIComponent(path.slice(1));
      if (relative === "halo-login.js") return sendBody(request, response, cache(loginVersion), JAVASCRIPT, LOGIN_SCRIPT);
      if (relative === "halo-handlers.js") {
        return sendBody(request, response, cache(handlersVersion), JAVASCRIPT, HANDLERS_SCRIPT);
      }
      if (relative === "activity.js") {
        const bundle = await activityBundle();
        return sendBody(request, response, cache(contentVersion(bundle)), JAVASCRIPT, bundle);
      }
      if (Object.hasOwn(HOSTED_FILES, relative)) {
        const file = hosted[relative]!;
        return sendBody(request, response, cache(file.version), HOSTED_FILES[relative]!, file.body);
      }
      const image = gameImage(relative);
      if (image) {
        if (!requestSession(config, request)) {
          response.writeHead(401, { ...headers, Vary: MAP_CACHE.Vary, "Content-Type": "text/plain" })
            .end("login required");
          return;
        }
        await serveFile(request, response, config.uiDir, image, "image/png", { ...headers, ...MAP_CACHE }, false);
        return;
      }
      if (Object.hasOwn(ICONS, relative)) {
        await serveFile(request, response, ICON_DIRECTORY, relative, ICONS[relative]!, cache(iconVersions[relative]!), false);
        return;
      }
      const shell = /^halo-shell-(\d{1,2})\.js$/.exec(relative);
      if (shell) {
        const page = await source();
        const script = page === null ? undefined : hostedPage(page).scripts[Number(shell[1])];
        if (script === undefined) return notFound();
        return sendBody(request, response, cache(contentVersion(script)), JAVASCRIPT, script);
      }
      const map = mapFile(relative);
      if (map) {
        const session = requestSession(config, request);
        if (!session) {
          response.writeHead(401, { ...headers, Vary: MAP_CACHE.Vary, "Content-Type": "text/plain" })
            .end("login required");
          return;
        }
        /* (diagnostics: when a game reads its maps, and how long each read takes) */
        const started = Date.now();
        const bytes = await serveFile(request, response, config.mapsDir, map,
          map.endsWith(".shaders") ? "text/plain; charset=utf-8" : "application/octet-stream",
          { ...headers, ...MAP_CACHE }, true);
        if (config.netstatsUpload) {
          response.once("finish", () => log({
            event: "map", user: session.sub, file: map, range: request.headers.range ?? null,
            status: response.statusCode, bytes, ms: Date.now() - started,
          }));
        }
        return;
      }
      const build = buildFile(relative);
      if (build?.file === "halo.html") {
        const page = await source();
        if (page === null) return notFound();
        const activity = context === "activity";
        const { html } = hostedPage(page, activity ? activityPage : null, await versions(),
          { netstatsUpload: config.netstatsUpload });
        return sendBody(request, response,
          activity ? { ...headers, "Content-Security-Policy": ACTIVITY_CSP } : headers, build.type, html);
      }
      if (build) {
        const version = build.file === "halo.js" || build.file === "halo.wasm" ? await appVersion() : null;
        await serveFile(request, response, config.buildDir, build.file, build.type,
          version ? cache(version) : { ...headers, "Cache-Control": REVALIDATE }, false);
        return;
      }
      response.writeHead(404, { ...headers, "Content-Type": "text/plain" }).end("not found");
    } catch (error) {
      if (!response.headersSent) response.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": NO_STORE }).end("bad request");
      else response.destroy();
      if (!(error instanceof URIError)) log({ event: "http-error", message: (error as Error).message });
    }
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAXIMUM_BATCH_BYTES });
  server.on("upgrade", (request: IncomingMessage, stream: Duplex, head: Buffer) => {
    /* Node stops watching an upgraded connection for errors, so a client that
       resets it (while it is refused, say) would end the process; ws watches
       it again once it accepts the upgrade. */
    stream.on("error", () => {});
    const reject = (status: number, message: string) => {
      stream.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    const match = /^\/v1\/rooms\/([^/]+)\/ws$/.exec(splitContext(url).path);
    if (!match) return reject(404, "Not Found");
    const roomId = match[1]!;
    const query = parseSocketQuery(url);
    if (!ROOM_ID_PATTERN.test(roomId) || !query) return reject(400, "Bad Request");
    if (!origins.has(request.headers.origin ?? "")) return reject(403, "Forbidden");
    sockets.handleUpgrade(request, stream, head, (socket) => {
      /* ws reports a client's protocol errors (an unmasked frame, a bad
         opcode, invalid UTF-8, a message over maxPayload) as "error" events,
         and an "error" nobody listens for ends the process. So listen first,
         before authentication, for the socket's whole life. */
      const context: SocketContext = { room: roomId.slice(0, 8), user: null, id: null };
      socket.on("error", (error: Error & { code?: string }) => {
        log({ event: "error", ...context, code: error.code ?? null, message: error.message });
      });
      watch(socket);
      authenticate(socket, roomId, query, context);
    });
  });

  /* Browsers cannot set headers on a WebSocket, so the token arrives in the
     first message: {type: "auth", token, id, build}. */
  function authenticate(socket: WebSocket, roomId: string, query: NonNullable<ReturnType<typeof parseSocketQuery>>,
      context: SocketContext) {
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
      Object.assign(context, { user: session.sub, id: message.id });
      relay.join(socket, roomId, {
        user: session.sub, name: session.name, id: message.id, role: query.role, kind: query.kind,
      }, message.build, accessOf(session, roomId));
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
