import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";
import { joinBatch, sanitizeName, splitBatch } from "../src/protocol.ts";
import { buildFile, mapFile, parseRange } from "../src/static.ts";
import { issueToken, verifyToken } from "../src/tokens.ts";

const SECRET = "x".repeat(40);

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

  it("loads a production configuration", () => {
    expect(loadConfig(base)).toMatchObject({ host: "127.0.0.1", port: 8080, devLogin: false,
      discord: { clientId: "1", guildId: "3" } });
  });

  it("allows the development login only in development on loopback", () => {
    const dev = { ...base, DEV_LOGIN: "1", NODE_ENV: "development" };
    expect(loadConfig(dev).devLogin).toBe(true);
    expect(() => loadConfig({ ...dev, NODE_ENV: "production" })).toThrow(/DEV_LOGIN/);
    expect(() => loadConfig({ ...dev, HOST: "0.0.0.0" })).toThrow(/DEV_LOGIN/);
    expect(() => loadConfig({ ...base, TOKEN_SECRET: "short" })).toThrow(/TOKEN_SECRET/);
    expect(() => loadConfig({ ...base, DISCORD_CLIENT_ID: "" })).toThrow(/DISCORD_CLIENT_ID/);
  });
});
