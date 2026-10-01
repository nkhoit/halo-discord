import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import { WebSocket } from "ws";

import { type App, createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import type { DiscordApi, DiscordUser } from "../src/discord.ts";
import { issueToken } from "../src/tokens.ts";

export const ORIGIN = "http://127.0.0.1:9";
export const SECRET = "test-secret-test-secret-test-secret-123";

/* Shaped like the minified build/web/halo.html. */
export const PAGE = '<!doctypehtml><html lang=en><head><meta charset=utf-8>' +
  '<meta name="halo-signaling-url" content="http://127.0.0.1:8787">' +
  '<meta name="halo-relay-url" content="https://relay.example">' +
  '<meta content=web-multiplayer-v1 name=halo-build-id><script src=coi-serviceworker.js></script>' +
  '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"async defer></script>' +
  '<title>Halo</title><script src=halo.js async></script><body><canvas id=canvas></canvas>';

/* Codes map to users; a user is a guild member unless listed in outsiders. */
export class FakeDiscord implements DiscordApi {
  readonly users = new Map<string, DiscordUser>();
  readonly outsiders = new Set<string>();
  readonly exchanges: { code: string; redirectUri?: string }[] = [];

  async exchangeCode(code: string, redirectUri?: string): Promise<string> {
    this.exchanges.push({ code, redirectUri });
    if (!this.users.has(code)) throw new Error("invalid code");
    return `access-${code}`;
  }

  async getUser(accessToken: string): Promise<DiscordUser> {
    return this.users.get(accessToken.replace(/^access-/, ""))!;
  }

  async isGuildMember(accessToken: string): Promise<boolean> {
    return !this.outsiders.has(accessToken.replace(/^access-/, ""));
  }
}

export function fixtures(): { buildDir: string; mapsDir: string } {
  const root = mkdtempSync(joinPath(tmpdir(), "halo-server-test-"));
  const buildDir = joinPath(root, "build");
  const mapsDir = joinPath(root, "maps");
  mkdirSync(joinPath(buildDir, "assets", "ui", "maps"), { recursive: true });
  mkdirSync(mapsDir);
  writeFileSync(joinPath(buildDir, "halo.html"), PAGE);
  writeFileSync(joinPath(buildDir, "halo.js"), "console.log('halo');");
  writeFileSync(joinPath(buildDir, "halo.wasm"), Buffer.from([0, 97, 115, 109]));
  writeFileSync(joinPath(buildDir, "secret.txt"), "not for you");
  writeFileSync(joinPath(buildDir, "assets", "ui", "maps", "blood-gulch.png"), "png");
  writeFileSync(joinPath(mapsDir, "bloodgulch.map"), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
  writeFileSync(joinPath(mapsDir, "a10.map"), "campaign");
  return { buildDir, mapsDir };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    publicOrigin: ORIGIN,
    extraOrigins: [],
    ...fixtures(),
    discord: { clientId: "123", clientSecret: "shh", guildId: "guild" },
    tokenSecret: SECRET,
    tokenTtlSeconds: 3600,
    devLogin: false,
    trustProxy: "none",
    authRateLimitPerMinute: 1000,
    maxRooms: 64,
    ...overrides,
  };
}

export interface Running {
  app: App;
  discord: FakeDiscord;
  base: string;
  logs: Record<string, unknown>[];
  close(): Promise<void>;
}

export async function start(overrides: Partial<Config> = {}, authDeadline = 300, heartbeat = 30_000): Promise<Running> {
  const discord = new FakeDiscord();
  const logs: Record<string, unknown>[] = [];
  const app = createApp(testConfig(overrides), discord, (entry) => logs.push(entry), authDeadline, heartbeat);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    discord,
    base: `http://127.0.0.1:${port}`,
    logs,
    close: () => new Promise((resolve) => {
      for (const socket of app.sockets.clients) socket.terminate();
      app.server.closeAllConnections();
      app.server.close(() => resolve());
    }),
  };
}

export function token(sub: string, name = sub, ttl = 3600): string {
  return issueToken(SECRET, sub, name, ttl).token;
}

export interface Client {
  socket: WebSocket;
  texts: Record<string, unknown>[];
  frames: Uint8Array[];
  messages: number;
  closed: Promise<{ code: number; reason: string }>;
}

export function open(base: string, room: string, role: string, ch = "both", origin = ORIGIN): Client {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/v1/rooms/${room}/ws?role=${role}&ch=${ch}`,
    { headers: { Origin: origin } });
  const client: Client = {
    socket,
    texts: [],
    frames: [],
    messages: 0,
    closed: new Promise((resolve) => socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() }))),
  };
  socket.on("error", () => {});
  socket.on("message", (data, isBinary) => {
    client.messages++;
    if (!isBinary) {
      client.texts.push(JSON.parse(data.toString()));
      return;
    }
    const bytes = new Uint8Array(data as Buffer);
    if (bytes[0] === 0x80) {
      let offset = 1;
      while (offset < bytes.length) {
        const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
        client.frames.push(bytes.slice(offset + 2, offset + 2 + length));
        offset += 2 + length;
      }
    } else {
      client.frames.push(bytes.slice());
    }
  });
  return client;
}

export async function until(condition: () => boolean, milliseconds = 2000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function join(base: string, room: string, role: string, user: string, id: string,
    options: { ch?: string; build?: string; name?: string } = {}): Promise<Client> {
  const client = open(base, room, role, options.ch);
  await new Promise<void>((resolve, reject) => {
    client.socket.once("open", () => resolve());
    client.socket.once("error", reject);
  });
  client.socket.send(JSON.stringify({ type: "auth", token: token(user, options.name), id, build: options.build ?? "b1" }));
  await until(() => client.texts.some((text) => text.type === "ready"));
  return client;
}

export function frame(channel: number, id: string, payloadBytes?: number, marker = 0x48): Uint8Array {
  const size = payloadBytes ?? (channel === 0 ? 20 : 12);
  const bytes = new Uint8Array(7 + size);
  bytes[0] = channel;
  for (let index = 0; index < 6; index++) bytes[1 + index] = parseInt(id.slice(index * 2, index * 2 + 2), 16);
  bytes[7] = marker;
  return bytes;
}

export function sender(bytes: Uint8Array): string {
  return [...bytes.subarray(1, 7)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));
