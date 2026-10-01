/* Discord login. A browser signs in with OAuth2 (redirect flow); the Discord
   Activity will exchange an Embedded App SDK code instead. Either way the
   server checks guild membership and issues a short-lived session token,
   which also travels as an HttpOnly cookie so the game's map requests (made
   from pthread workers) carry it without the token ever entering a URL. */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config } from "./config.ts";
import type { DiscordApi, DiscordUser } from "./discord.ts";
import { sanitizeName } from "./protocol.ts";
import { issueToken, type Session, verifyToken } from "./tokens.ts";

export const SESSION_COOKIE = "halo_session";
const STATE_COOKIE = "halo_oauth";
const DEFAULT_RETURN = "/halo.html";

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

/* The session from the cookie or an Authorization: Bearer header. */
export function requestSession(config: Config, request: IncomingMessage): Session | null {
  const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
  return verifyToken(config.tokenSecret, bearer ?? parseCookies(request.headers.cookie)[SESSION_COOKIE]);
}

/* Only a same-site path, so a login cannot redirect anywhere else. */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || value.length > 512 || !value.startsWith("/") || value.startsWith("//") || /[\\\s]/.test(value)) {
    return DEFAULT_RETURN;
  }
  return value;
}

function cookie(config: Config, name: string, value: string, options: {
  maxAge: number; path?: string; partitioned?: boolean;
}): string {
  const secure = config.publicOrigin.startsWith("https:");
  const parts = [`${name}=${value}`, `Path=${options.path ?? "/"}`, `Max-Age=${options.maxAge}`, "HttpOnly"];
  /* The Activity runs in a cross-site iframe: its cookie must be
     SameSite=None and partitioned to that embedding. */
  if (options.partitioned && secure) parts.push("SameSite=None", "Secure", "Partitioned");
  else parts.push("SameSite=Lax", ...(secure ? ["Secure"] : []));
  return parts.join("; ");
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" })
    .end(JSON.stringify(body));
}

function page(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
    .end(message);
}

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly limit: number;

  constructor(limitPerMinute: number) {
    this.limit = limitPerMinute;
  }

  allow(key: string, now = Date.now()): boolean {
    const window = this.windows.get(key);
    if (!window || now - window.start >= 60_000) {
      if (this.windows.size > 10_000) this.windows.clear();
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    return ++window.count <= this.limit;
  }
}

export function clientAddress(config: Config, request: IncomingMessage): string {
  if (config.trustProxy === "cloudflare") {
    const value = request.headers["cf-connecting-ip"];
    if (typeof value === "string" && value) return value;
  } else if (config.trustProxy === "forwarded") {
    const value = request.headers["x-forwarded-for"];
    const last = typeof value === "string" ? value.split(",").pop()?.trim() : undefined;
    if (last) return last;
  }
  return request.socket.remoteAddress ?? "unknown";
}

export class Auth {
  private readonly config: Config;
  private readonly discord: DiscordApi | null;
  private readonly limiter: RateLimiter;

  constructor(config: Config, discord: DiscordApi | null) {
    this.config = config;
    this.discord = discord;
    this.limiter = new RateLimiter(config.authRateLimitPerMinute);
  }

  /* Handles /auth/*; returns false for other paths. */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith("/auth/")) return false;
    if (!this.limiter.allow(clientAddress(this.config, request))) {
      page(response, 429, "Too many requests. Try again in a minute.");
      return true;
    }
    const route = `${request.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /auth/login": this.login(response, url); break;
        case "GET /auth/callback": await this.callback(request, response, url); break;
        case "GET /auth/session": this.session(request, response); break;
        case "POST /auth/logout": this.logout(response); break;
        case "POST /auth/activity": await this.activity(request, response); break;
        case "GET /auth/dev-login": this.devLogin(response, url); break;
        default: page(response, 404, "not found");
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "auth-error", route, message: (error as Error).message }));
      page(response, 502, "Discord could not be reached. Try again.");
    }
    return true;
  }

  private redirectUri(): string {
    return `${this.config.publicOrigin}/auth/callback`;
  }

  private login(response: ServerResponse, url: URL): void {
    if (!this.config.discord) return page(response, 404, "Discord login is not configured");
    const state = randomBytes(32).toString("base64url");
    const returnPath = Buffer.from(safeReturnPath(url.searchParams.get("return"))).toString("base64url");
    const authorize = new URL("https://discord.com/oauth2/authorize");
    authorize.search = new URLSearchParams({
      client_id: this.config.discord.clientId,
      redirect_uri: this.redirectUri(),
      response_type: "code",
      scope: "identify guilds",
      state,
      prompt: "none",
    }).toString();
    response.writeHead(302, {
      Location: authorize.href,
      "Set-Cookie": cookie(this.config, STATE_COOKIE, `${state}.${returnPath}`, { maxAge: 600, path: "/auth" }),
      "Cache-Control": "no-store",
    }).end();
  }

  private async callback(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!this.config.discord || !this.discord) return page(response, 404, "Discord login is not configured");
    const [state, returnPath] = (parseCookies(request.headers.cookie)[STATE_COOKIE] ?? "").split(".");
    const code = url.searchParams.get("code");
    if (!state || url.searchParams.get("state") !== state || !code) {
      return page(response, 400, "The login expired or was not started here. Open the game and log in again.");
    }
    const accessToken = await this.discord.exchangeCode(code, this.redirectUri());
    const user = await this.discord.getUser(accessToken);
    if (!await this.discord.isGuildMember(accessToken, this.config.discord.guildId)) {
      return page(response, 403, "This game is only open to members of its Discord server.");
    }
    const { token } = this.issue(user);
    response.writeHead(302, {
      Location: safeReturnPath(Buffer.from(returnPath ?? "", "base64url").toString("utf8")),
      "Set-Cookie": [
        cookie(this.config, SESSION_COOKIE, token, { maxAge: this.config.tokenTtlSeconds }),
        cookie(this.config, STATE_COOKIE, "", { maxAge: 0, path: "/auth" }),
      ],
      "Cache-Control": "no-store",
    }).end();
  }

  /* Renews a valid session: the page keeps its token fresh for relay
     reconnects, and gets a 401 when it has to log in. */
  private session(request: IncomingMessage, response: ServerResponse): void {
    const current = requestSession(this.config, request);
    if (!current) return json(response, 401, { error: "login required", loginUrl: "/auth/login" });
    const { token, session } = issueToken(this.config.tokenSecret, current.sub, current.name,
      this.config.tokenTtlSeconds);
    json(response, 200, { token, user: { id: session.sub, name: session.name }, expiresAt: session.exp }, {
      "Set-Cookie": cookie(this.config, SESSION_COOKIE, token, { maxAge: this.config.tokenTtlSeconds }),
    });
  }

  private logout(response: ServerResponse): void {
    json(response, 200, {}, { "Set-Cookie": cookie(this.config, SESSION_COOKIE, "", { maxAge: 0 }) });
  }

  /* The Discord Activity: the Embedded App SDK's authorize() gives a code;
     the Activity needs Discord's access token for authenticate() and ours
     for the relay and maps. */
  private async activity(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.config.discord || !this.discord) return json(response, 404, { error: "not configured" });
    const body = await readJson(request);
    const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
    if (typeof code !== "string" || !code || code.length > 512) return json(response, 400, { error: "code required" });
    const accessToken = await this.discord.exchangeCode(code);
    const user = await this.discord.getUser(accessToken);
    if (!await this.discord.isGuildMember(accessToken, this.config.discord.guildId)) {
      return json(response, 403, { error: "not a member of the server" });
    }
    const { token, session } = this.issue(user);
    json(response, 200, {
      access_token: accessToken,
      token,
      user: { id: session.sub, name: session.name },
      expiresAt: session.exp,
    }, {
      "Set-Cookie": cookie(this.config, SESSION_COOKIE, token,
        { maxAge: this.config.tokenTtlSeconds, partitioned: true }),
    });
  }

  /* Local testing without Discord; only exists under DEV_LOGIN, which the
     configuration allows only in development on a loopback address. */
  private devLogin(response: ServerResponse, url: URL): void {
    if (!this.config.devLogin) return page(response, 404, "not found");
    const name = sanitizeName(url.searchParams.get("name") ?? "Developer");
    const { token } = issueToken(this.config.tokenSecret, `dev:${name}`, name, this.config.tokenTtlSeconds);
    response.writeHead(302, {
      Location: safeReturnPath(url.searchParams.get("return")),
      "Set-Cookie": cookie(this.config, SESSION_COOKIE, token, { maxAge: this.config.tokenTtlSeconds }),
      "Cache-Control": "no-store",
    }).end();
  }

  private issue(user: DiscordUser): { token: string; session: Session } {
    return issueToken(this.config.tokenSecret, user.id, user.globalName ?? user.username,
      this.config.tokenTtlSeconds);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 4096) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
