/* Configuration from the environment (see .env.example). */

import { isIP } from "node:net";
import { join } from "node:path";

export interface Config {
  port: number;
  host: string;
  publicOrigin: string;
  /* Extra origins allowed to open relay sockets, e.g. the Discord Activity's
     https://<application id>.discordsays.com. */
  extraOrigins: string[];
  buildDir: string;
  mapsDir: string;
  /* Images the lobby shows, extracted from the player's own ui.map
     (tools/web/extract-ui-images.mjs): maps/<slug>.png and modes/<slug>.png. */
  uiDir: string;
  discord: { clientId: string; clientSecret: string; guildIds: string[] } | null;
  tokenSecret: string;
  tokenTtlSeconds: number;
  /* How long after a Discord sign-in a session may still be renewed; then
     the player signs in again, which re-checks the guild allowlist. */
  sessionLifetimeSeconds: number;
  /* Development only: /auth/dev-login issues tokens without Discord. */
  devLogin: boolean;
  /* Take the client address from CF-Connecting-IP (behind cloudflared) or
     X-Forwarded-For's last hop (behind Caddy); otherwise the socket. */
  trustProxy: "none" | "cloudflare" | "forwarded";
  authRateLimitPerMinute: number;
  maxRooms: number;
  /* pages report their ?netstats=1 windows to POST /v1/netstats, logged */
  netstatsUpload: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function discordGuildIds(env: NodeJS.ProcessEnv): string[] {
  const plural = env.DISCORD_GUILD_IDS;
  if (plural === undefined) {
    const legacy = required(env, "DISCORD_GUILD_ID");
    if (!/^\d{1,20}$/.test(legacy)) throw new Error("DISCORD_GUILD_ID is invalid");
    return [legacy];
  }
  const guildIds = plural.split(",").map((guildId) => guildId.trim());
  if (!guildIds.length || guildIds.some((guildId) => !/^\d{1,20}$/.test(guildId))) {
    throw new Error("DISCORD_GUILD_IDS must be a comma-separated list of Discord guild IDs");
  }
  return [...new Set(guildIds)];
}

export function isLoopbackHost(host: string): boolean {
  if (host === "localhost") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return host === "::1";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = Number(env.PORT ?? 8090);
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
    guildIds: discordGuildIds(env),
  } : null;
  if (!discord && !devLogin) throw new Error("DISCORD_CLIENT_ID (or DEV_LOGIN in development) is required");
  const trustProxy = env.TRUST_PROXY ?? "none";
  if (trustProxy !== "none" && trustProxy !== "cloudflare" && trustProxy !== "forwarded") {
    throw new Error("TRUST_PROXY must be none, cloudflare or forwarded");
  }
  const sessionLifetimeSeconds = Number(env.SESSION_LIFETIME_SECONDS ?? 86400);
  if (!Number.isInteger(sessionLifetimeSeconds) || sessionLifetimeSeconds < 1) {
    throw new Error("SESSION_LIFETIME_SECONDS must be a positive whole number");
  }
  return {
    port,
    host,
    publicOrigin,
    extraOrigins: (env.EXTRA_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean)
      .map((value) => new URL(value).origin),
    buildDir: required(env, "BUILD_DIR"),
    mapsDir: required(env, "MAPS_DIR"),
    uiDir: env.UI_DIR?.trim() || join(required(env, "MAPS_DIR"), "ui"),
    discord,
    tokenSecret,
    tokenTtlSeconds: Number(env.TOKEN_TTL_SECONDS ?? 3600),
    sessionLifetimeSeconds,
    devLogin,
    trustProxy,
    authRateLimitPerMinute: Number(env.AUTH_RATE_LIMIT_PER_MINUTE ?? 30),
    maxRooms: Number(env.MAX_ROOMS ?? 64),
    netstatsUpload: env.NETSTATS_UPLOAD === "1",
  };
}
