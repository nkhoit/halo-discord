/* Configuration from the environment (see .env.example). */

import { isIP } from "node:net";

export interface Config {
  port: number;
  host: string;
  publicOrigin: string;
  /* Extra origins allowed to open relay sockets, e.g. the Discord Activity's
     https://<application id>.discordsays.com. */
  extraOrigins: string[];
  buildDir: string;
  mapsDir: string;
  discord: { clientId: string; clientSecret: string; guildId: string } | null;
  tokenSecret: string;
  tokenTtlSeconds: number;
  /* Development only: /auth/dev-login issues tokens without Discord. */
  devLogin: boolean;
  /* Take the client address from CF-Connecting-IP (behind cloudflared) or
     X-Forwarded-For's last hop (behind Caddy); otherwise the socket. */
  trustProxy: "none" | "cloudflare" | "forwarded";
  authRateLimitPerMinute: number;
  maxRooms: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function isLoopbackHost(host: string): boolean {
  if (host === "localhost") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return host === "::1";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid");
  const publicOrigin = new URL(required(env, "PUBLIC_ORIGIN")).origin;
  const tokenSecret = required(env, "TOKEN_SECRET");
  if (tokenSecret.length < 32) throw new Error("TOKEN_SECRET must be at least 32 characters");
  const devLogin = env.DEV_LOGIN === "1";
  if (devLogin && (env.NODE_ENV !== "development" || !isLoopbackHost(host))) {
    throw new Error("DEV_LOGIN needs NODE_ENV=development and a loopback HOST");
  }
  const discord = env.DISCORD_CLIENT_ID ? {
    clientId: required(env, "DISCORD_CLIENT_ID"),
    clientSecret: required(env, "DISCORD_CLIENT_SECRET"),
    guildId: required(env, "DISCORD_GUILD_ID"),
  } : null;
  if (!discord && !devLogin) throw new Error("DISCORD_CLIENT_ID (or DEV_LOGIN in development) is required");
  const trustProxy = env.TRUST_PROXY ?? "none";
  if (trustProxy !== "none" && trustProxy !== "cloudflare" && trustProxy !== "forwarded") {
    throw new Error("TRUST_PROXY must be none, cloudflare or forwarded");
  }
  return {
    port,
    host,
    publicOrigin,
    extraOrigins: (env.EXTRA_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean)
      .map((value) => new URL(value).origin),
    buildDir: required(env, "BUILD_DIR"),
    mapsDir: required(env, "MAPS_DIR"),
    discord,
    tokenSecret,
    tokenTtlSeconds: Number(env.TOKEN_TTL_SECONDS ?? 3600),
    devLogin,
    trustProxy,
    authRateLimitPerMinute: Number(env.AUTH_RATE_LIMIT_PER_MINUTE ?? 30),
    maxRooms: Number(env.MAX_ROOMS ?? 64),
  };
}
