import { createHmac } from "node:crypto";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.ts";
import { HttpDiscordApi } from "../src/discord.ts";
import { joinBatch, sanitizeName, splitBatch } from "../src/protocol.ts";
import { buildFile, contentVersion, gameImage,
  hostedPage, LOGIN_SCRIPT, mapFile, parseRange } from "../src/static.ts";
import { issueToken, verifyToken } from "../src/tokens.ts";
import { PAGE } from "./harness.ts";

const SECRET = "x".repeat(40);

describe("the hosted page", () => {
  it("uses relay rooms, drops other services and waits for a session before the game", () => {
    const { html } = hostedPage(PAGE);
    expect(html).toContain('<meta name="halo-transport" content="relay-rooms">');
    expect(html).toContain("name=halo-build-id");
    for (const gone of ["halo-signaling-url", "halo-relay-url", "coi-serviceworker", "challenges.cloudflare.com",
        "<script src=halo.js", "halo-activity"]) {
      expect(html, gone).not.toContain(gone);
    }
    expect(html).toMatch(/<script src="halo-login\.js\?v=[0-9a-f]{16}"><\/script>/);
    expect(LOGIN_SCRIPT).toMatch(/fetch\("auth\/session"[\s\S]*haloStartGame\(\)/);
  });

  it("moves inline scripts and handlers into files, in place and in order", () => {
    const { html, scripts } = hostedPage(PAGE);
    expect(scripts).toEqual(["window.shellRan = true;"]);
    expect(html).toContain('<canvas id=canvas data-halo-oncontextmenu=event.preventDefault() tabindex=-1>');
    expect(html.indexOf(`src="halo-shell-0.js?v=${contentVersion("window.shellRan = true;")}"`))
      .toBeGreaterThan(html.indexOf("<canvas"));
    expect(html).toMatch(/<script src="halo-handlers\.js\?v=[0-9a-f]{16}"><\/script>$/);
    expect(html).not.toMatch(/<script>/);
    expect(hostedPage("<script src=halo.js></script><p>no handlers</p>").html).not.toContain("halo-handlers.js");
  });

  it("starts the Activity through the Discord SDK loader", () => {
    const { html } = hostedPage(PAGE, { clientId: "1555", publicOrigin: "https://halo.example", dev: false });
    expect(html).toContain('<meta name="halo-activity" content="1555">');
    expect(html).toContain('<meta name="halo-public-origin" content="https://halo.example">');
    expect(html).toContain('<script src="activity.js"></script>');
    expect(html).not.toContain("halo-login.js");
    const pinned = hostedPage(PAGE, { clientId: "1555", publicOrigin: "https://halo.example", dev: false },
      { app: "aaaa", activity: "bbbb", icons: { "favicon.ico": "cccc" }, hostedScript: "dddd", hostedStyle: "eeee" }).html;
    expect(pinned).toContain('<meta name="halo-asset-version" content="aaaa">');
    expect(pinned).toContain('<link rel="stylesheet" href="hosted.css?v=eeee"><script src="hosted.js?v=dddd"></script>');
    expect(pinned.indexOf("hosted.js")).toBeLessThan(pinned.indexOf("activity.js"));
    expect(pinned).toContain('<script src="activity.js?v=bbbb"></script>');
    expect(pinned).toContain('href="favicon.ico?v=cccc"');
    expect(html).not.toContain("halo-activity-dev");
    const quoted = hostedPage(PAGE, { clientId: '"><script>', publicOrigin: "x", dev: true }).html;
    expect(quoted).toContain('content="&quot;>&lt;script>"');
    expect(quoted).toContain('<meta name="halo-activity-dev" content="1">');
  });

  it("takes the hosted page's own UI in both contexts", () => {
    for (const activity of [null, { clientId: "1555", publicOrigin: "https://halo.example", dev: false }]) {
      const { html } = hostedPage("<!doctype html><html lang=en><body><script src=halo.js></script></body></html>", activity);
      expect(html).toContain('<html lang=en class="halo-hosted">');
      expect(html).toMatch(/<link rel="stylesheet" href="hosted\.css"><script src="hosted\.js"><\/script>/);
    }
  });

  it("refuses a page that does not load the game exactly once", () => {
    expect(() => hostedPage("<title>Halo</title>")).toThrow(/halo\.js/);
    expect(() => hostedPage('<script src=halo.js></script><script src="halo.js"></script>')).toThrow(/halo\.js/);
  });
});

describe("the lobby's images", () => {
  it("allows only the listed map previews and game type icons", () => {
    expect(gameImage("game-ui/maps/blood-gulch.png")).toBe("maps/blood-gulch.png");
    expect(gameImage("game-ui/modes/king-of-the-hill.png")).toBe("modes/king-of-the-hill.png");
    for (const path of ["game-ui/maps/a10.png", "game-ui/modes/blood-gulch.png", "game-ui/maps/../secret.png",
        "game-ui/maps/blood-gulch.jpg", "game-ui/secret.png", "game-ui/maps/Blood-Gulch.png", "game-ui/maps//wizard.png"]) {
      expect(gameImage(path), path).toBeNull();
    }
  });
});

describe("tokens", () => {
  it("round-trips and binds the Discord user", () => {
    const { token } = issueToken(SECRET, "1234", "Chief", 60);
    expect(verifyToken(SECRET, token)).toMatchObject({ sub: "1234", name: "Chief" });
  });

  it("rejects tampering, other secrets, expiry and junk", () => {
    const { token } = issueToken(SECRET, "1234", "Chief", 60);
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, sub: "999", name: "x", exp: 9e9 })).toString("base64url");
    expect(verifyToken(SECRET, `${forged}.${signature}`)).toBeNull();
    expect(verifyToken("y".repeat(40), token)).toBeNull();
    expect(verifyToken(SECRET, token, Date.now() + 61_000)).toBeNull();
    expect(verifyToken(SECRET, `${payload}`)).toBeNull();
    expect(verifyToken(SECRET, `${token}.x`)).toBeNull();
    expect(verifyToken(SECRET, 42)).toBeNull();
  });

  it("carry the sign-in time, which a renewal passes on unchanged", () => {
    const now = Date.UTC(2026, 0, 1);
    const first = issueToken(SECRET, "1234", "Chief", 60, now);
    expect(first.session.auth).toBe(now / 1000);
    expect(verifyToken(SECRET, first.token, now)?.auth).toBe(now / 1000);
    const later = now + 3_600_000;
    const renewed = issueToken(SECRET, "1234", "Chief", 60, later, first.session.auth);
    expect(verifyToken(SECRET, renewed.token, later)).toMatchObject({ auth: now / 1000, exp: later / 1000 + 60 });
  });

  it("read tokens from before the sign-in time without one", () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, sub: "1234", name: "Chief", exp: 9e9 })).toString("base64url");
    const signature = createHmac("sha256", SECRET).update(payload).digest("base64url");
    const session = verifyToken(SECRET, `${payload}.${signature}`);
    expect(session).toMatchObject({ sub: "1234" });
    expect(session).not.toHaveProperty("auth");
  });
});

describe("display names", () => {
  it("are single-line, printable and bounded", () => {
    expect(sanitizeName("  Master\u0000\nChief \u202e ")).toBe("Master Chief");
    expect(sanitizeName("x".repeat(100))).toHaveLength(32);
    expect(sanitizeName("😀".repeat(40))).toBe("😀".repeat(32));
    expect(sanitizeName("\u0007")).toBe("Player");
    expect(sanitizeName(null)).toBe("Player");
  });
});

describe("batches", () => {
  it("round-trip and reject malformed framing", () => {
    const frames = [new Uint8Array([1, 2, 3]), new Uint8Array(300).fill(7)];
    expect(splitBatch(joinBatch(frames))).toEqual(frames);
    expect(splitBatch(new Uint8Array([0x80]))).toBeNull();
    expect(splitBatch(new Uint8Array([0x80, 0, 5, 1, 2]))).toBeNull();
    expect(splitBatch(new Uint8Array([0x80, 0, 0]))).toBeNull();
    expect(splitBatch(new Uint8Array([0x81, 0, 1, 1]))).toBeNull();
  });
});

describe("file allowlists", () => {
  it("expose only the page, wasm, UI images and multiplayer maps", () => {
    expect(buildFile("halo.html")?.type).toMatch(/text\/html/);
    expect(buildFile("halo.wasm")?.type).toBe("application/wasm");
    expect(buildFile("assets/ui/maps/blood-gulch.png")?.type).toBe("image/png");
    for (const path of ["secret.txt", "../halo.html", "assets/ui/../../secret.txt", "assets/ui/..png",
        "assets/ui/a\\b.png", "halo.html/", "HALO.HTML", "halo_msvc_semantics.h", "constructor", "toString"]) {
      expect(buildFile(path), path).toBeNull();
    }
    expect(mapFile("assets/maps/bloodgulch.map")).toBe("bloodgulch.map");
    expect(mapFile("assets/maps/ui.map")).toBe("ui.map");
    expect(mapFile("assets/maps/beavercreek.shaders")).toBe("beavercreek.shaders");
    expect(mapFile("assets/maps/a10.shaders")).toBeNull();
    expect(mapFile("assets/maps/beavercreek.txt")).toBeNull();
    for (const path of ["assets/maps/a10.map", "assets/maps/../maps/ui.map", "assets/maps/ui.map.bak",
        "assets/maps//ui.map", "assets/maps/UI.map", "maps/ui.map"]) {
      expect(mapFile(path), path).toBeNull();
    }
  });

  it("parses single byte ranges", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=0-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-1", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,5-6", 1000)).toBeNull();
    expect(parseRange(undefined, 1000)).toBeNull();
  });
});

describe("configuration", () => {
  const base = {
    PUBLIC_ORIGIN: "https://halo.example", BUILD_DIR: "b", MAPS_DIR: "m", TOKEN_SECRET: SECRET,
    DISCORD_CLIENT_ID: "1", DISCORD_CLIENT_SECRET: "2", DISCORD_GUILD_ID: "3",
  };

  it("loads a production configuration with the legacy single-guild setting", () => {
    expect(loadConfig(base)).toMatchObject({ host: "127.0.0.1", port: 8090, devLogin: false,
      discord: { clientId: "1", guildIds: ["3"] } });
  });

  it("loads a plural-only allowlist and gives it precedence over the legacy setting", () => {
    expect(loadConfig({ ...base, DISCORD_GUILD_ID: undefined, DISCORD_GUILD_IDS: "4" }).discord)
      .toMatchObject({ guildIds: ["4"] });
    expect(loadConfig({ ...base, DISCORD_GUILD_IDS: "4,5" }).discord)
      .toMatchObject({ guildIds: ["4", "5"] });
  });

  it("trims and deduplicates plural guild IDs while preserving first-seen order", () => {
    expect(loadConfig({ ...base, DISCORD_GUILD_IDS: " 4 , 5,4, 5 " }).discord)
      .toMatchObject({ guildIds: ["4", "5"] });
    expect(loadConfig({ ...base, DISCORD_GUILD_IDS: "0" }).discord)
      .toMatchObject({ guildIds: ["0"] });
  });

  it("rejects missing, empty, or malformed guild settings rather than falling back", () => {
    expect(() => loadConfig({ ...base, DISCORD_GUILD_ID: undefined })).toThrow(/DISCORD_GUILD_ID/);
    expect(() => loadConfig({ ...base, DISCORD_GUILD_IDS: "" })).toThrow(/DISCORD_GUILD_IDS/);
    expect(() => loadConfig({ ...base, DISCORD_GUILD_IDS: "   ", DISCORD_GUILD_ID: "3" }))
      .toThrow(/DISCORD_GUILD_IDS/);
    expect(() => loadConfig({ ...base, DISCORD_GUILD_IDS: "4,,5" })).toThrow(/DISCORD_GUILD_IDS/);
    expect(() => loadConfig({ ...base, DISCORD_GUILD_IDS: "not-a-guild" })).toThrow(/DISCORD_GUILD_IDS/);
    expect(() => loadConfig({ ...base, DISCORD_GUILD_ID: "not-a-guild" })).toThrow(/DISCORD_GUILD_ID/);
  });

  it("allows the development login only in development on loopback", () => {
    const dev = { ...base, DEV_LOGIN: "1", NODE_ENV: "development" };
    expect(loadConfig(dev).devLogin).toBe(true);
    expect(() => loadConfig({ ...dev, NODE_ENV: "production" })).toThrow(/DEV_LOGIN/);
    expect(() => loadConfig({ ...dev, HOST: "0.0.0.0" })).toThrow(/DEV_LOGIN/);
    expect(() => loadConfig({ ...base, TOKEN_SECRET: "short" })).toThrow(/TOKEN_SECRET/);
    expect(() => loadConfig({ ...base, DISCORD_CLIENT_ID: "" })).toThrow(/DISCORD_CLIENT_ID/);
  });

  it("bounds sessions to a whole-second lifetime, 24 h by default", () => {
    expect(loadConfig(base).sessionLifetimeSeconds).toBe(86400);
    expect(loadConfig({ ...base, SESSION_LIFETIME_SECONDS: "600" }).sessionLifetimeSeconds).toBe(600);
    for (const value of ["", "0", "-5", "1.5", "a day"]) {
      expect(() => loadConfig({ ...base, SESSION_LIFETIME_SECONDS: value }), value).toThrow(/SESSION_LIFETIME_SECONDS/);
    }
  });
});

describe("Discord API guild lookup", () => {
  it("checks every allowed guild with one guild-list request and returns the actual match", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://discord.com/api/v10/users/@me/guilds");
      expect(init?.headers).toEqual({ Authorization: "Bearer access-token" });
      return new Response(JSON.stringify([{ id: "unrelated" }, { id: "second" }]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const api = new HttpDiscordApi("client", "secret");
      await expect(api.findGuildMembership("access-token", ["first", "second", "third"]))
        .resolves.toBe("second");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects failed guild-list requests so auth can fail closed", async () => {
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const api = new HttpDiscordApi("client", "secret");
      await expect(api.findGuildMembership("access-token", ["first", "second"]))
        .rejects.toThrow(/failed \(503\)/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the game loader", () => {
  async function run(readyState: string) {
    const appended: { src?: string }[] = [];
    const listeners: Record<string, () => void> = {};
    const context: Record<string, unknown> = {
      document: {
        readyState,
        querySelector: (selector: string) =>
          selector === 'meta[name="halo-asset-version"]' ? { content: "abc123" } : null,
        createElement: () => ({}),
        head: { appendChild: (element: { src?: string }) => appended.push(element) },
        addEventListener: (type: string, listener: () => void) => { listeners[type] = listener; },
      },
      location: { pathname: "/", search: "", hash: "", replace() {} },
      fetch: async () => ({ status: 200, ok: true, json: async () => ({ user: { id: "7", name: "Chief" } }) }),
      console,
    };
    context.window = context;
    vm.runInNewContext(LOGIN_SCRIPT, context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { appended, listeners, context };
  }

  it("loads halo.js and halo.wasm at the page's version, after the shell", async () => {
    const waiting = await run("loading");
    expect(waiting.appended).toEqual([]);
    waiting.listeners.DOMContentLoaded!();
    expect(waiting.appended.map((element) => element.src)).toEqual(["halo.js?v=abc123"]);
    const module = (waiting.context.Module as { locateFile: (path: string, directory: string) => string });
    expect(module.locateFile("halo.wasm", "https://halo.example/")).toBe("https://halo.example/halo.wasm?v=abc123");
    expect(module.locateFile("other.data", "https://halo.example/")).toBe("https://halo.example/other.data");
    expect(waiting.context.HaloHostedUser).toEqual({ id: "7", name: "Chief" });
    const ready = await run("complete");
    expect(ready.appended.map((element) => element.src)).toEqual(["halo.js?v=abc123"]);
  });
});
