/* Short-lived session tokens: base64url(JSON payload).base64url(HMAC-SHA256).
   They name a Discord user and expire; nothing else is trusted from a client. */

import { createHmac, timingSafeEqual } from "node:crypto";

import { sanitizeName } from "./protocol.ts";

export interface Session {
  /* Discord user ID (or dev:<name> under DEV_LOGIN). */
  sub: string;
  name: string;
  /* Expiry, seconds since the epoch. */
  exp: number;
}

function sign(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function issueToken(secret: string, sub: string, name: string, ttlSeconds: number,
    now = Date.now()): { token: string; session: Session } {
  const session: Session = { sub, name: sanitizeName(name), exp: Math.floor(now / 1000) + ttlSeconds };
  const payload = Buffer.from(JSON.stringify({ v: 1, ...session })).toString("base64url");
  return { token: `${payload}.${sign(secret, payload)}`, session };
}

export function verifyToken(secret: string, token: unknown, now = Date.now()): Session | null {
  if (typeof token !== "string" || token.length > 2048) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(secret, payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let value: { v?: unknown; sub?: unknown; name?: unknown; exp?: unknown };
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (value.v !== 1 || typeof value.sub !== "string" || !value.sub || typeof value.exp !== "number") return null;
  if (value.exp * 1000 <= now) return null;
  return { sub: value.sub, name: sanitizeName(value.name), exp: value.exp };
}
