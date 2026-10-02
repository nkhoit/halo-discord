import { writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activityRoomId } from "../src/auth.ts";

import { fixtures, join, open, type Running, SECRET, start, token } from "./harness.ts";

let server: Running;
beforeEach(async () => { server = await start(); });
afterEach(async () => { await server.close(); });

const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  fetch(server.base + path, { headers, method, redirect: "manual" });

function cookies(response: Response): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const [name, value] = pair!.split("=");
    found[name!] = value ?? "";
  }
  return found;
}

describe("the page", () => {
  it("is public and cross-origin isolated", async () => {
    const response = await get("/halo.html");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<meta name="halo-transport" content="relay-rooms">');
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response.headers.get("document-isolation-policy")).toBeNull();
    expect((await get("/halo.wasm")).headers.get("content-type")).toBe("application/wasm");
    const root = await get("/");
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("relay-rooms");
  });

  it("uses Document-Isolation-Policy under /activity for the Discord Activity", async () => {
    const response = await get("/activity/halo.html");
    expect(response.status).toBe(200);
    expect(response.headers.get("document-isolation-policy")).toBe("isolate-and-require-corp");
    expect(response.headers.get("cross-origin-opener-policy")).toBeNull();
    for (const root of ["/activity", "/activity/"]) {
      const page = await get(root);
      expect(page.status, root).toBe(200);
      expect(page.headers.get("document-isolation-policy"), root).toBe("isolate-and-require-corp");
    }
  });

  it("serves nothing outside the allowlist", async () => {
    for (const path of ["/secret.txt", "/../secret.txt", "/%2e%2e/secret.txt", "/assets/ui/%2e%2e/%2e%2e/secret.txt",
        "/assets/maps/a10.map", "/assets/maps/%2e%2e/maps/a10.map", "/%E0%A4%A", "/assets/maps/bloodgulch.map/"]) {
      const response = await get(path, { Cookie: `halo_session=${token("1")}` });
      expect([400, 404], path).toContain(response.status);
    }
  });
});

describe("maps", () => {
  it("need a session", async () => {
    expect((await get("/assets/maps/bloodgulch.map")).status).toBe(401);
    expect((await get("/assets/maps/bloodgulch.map", { Authorization: "Bearer junk" })).status).toBe(401);
    expect((await get("/assets/maps/bloodgulch.map", { Cookie: `halo_session=${token("1", "x", -1)}` })).status)
      .toBe(401);
  });

  it("serve HEAD and single byte ranges with a cookie or bearer token", async () => {
    const cookie = { Cookie: `halo_session=${token("1")}` };
    const head = await get("/assets/maps/bloodgulch.map", { ...cookie, Range: "bytes=0-" }, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("1000");
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    const range = await get("/assets/maps/bloodgulch.map", { ...cookie, Range: "bytes=10-19" });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const whole = await get("/assets/maps/bloodgulch.map", { Authorization: `Bearer ${token("1")}` });
    expect((await whole.arrayBuffer()).byteLength).toBe(1000);
    expect((await get("/assets/maps/bloodgulch.map", { ...cookie, Range: "bytes=2000-" })).status).toBe(416);
    expect((await get("/activity/assets/maps/bloodgulch.map", cookie)).status).toBe(200);
  });
});

describe("Discord login", () => {
  it("redirects to Discord with a state cookie and a safe return path", async () => {
    const response = await get("/auth/login?return=/halo.html?x=1");
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(location.searchParams.get("scope")).toBe("identify guilds");
    expect(location.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9/auth/callback");
    const state = location.searchParams.get("state")!;
    expect(cookies(response).halo_oauth!.startsWith(`${state}.`)).toBe(true);
  });

  async function login(code: string, returnPath = "/halo.html") {
    const start = await get(`/auth/login?return=${encodeURIComponent(returnPath)}`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    return get(`/auth/callback?code=${code}&state=${state}`, { Cookie: `halo_oauth=${cookies(start).halo_oauth}` });
  }

  it("issues a session for a guild member and returns to the game", async () => {
    server.discord.users.set("ok", { id: "4242", username: "chief", globalName: "Master Chief" });
    const response = await login("ok", "/halo.html");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/halo.html");
    const session = cookies(response).halo_session!;
    expect(response.headers.getSetCookie().find((line) => line.startsWith("halo_session"))).toMatch(/HttpOnly/);
    expect(server.discord.exchanges[0]).toEqual({ code: "ok", redirectUri: "http://127.0.0.1:9/auth/callback" });
    const renewed = await get("/auth/session", { Cookie: `halo_session=${session}` });
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toMatchObject({ user: { id: "4242", name: "Master Chief" } });
  });

  it("refuses non-members, forged state and off-site returns", async () => {
    server.discord.users.set("out", { id: "1", username: "stranger", globalName: null });
    server.discord.outsiders.add("out");
    expect((await login("out")).status).toBe(403);
    expect((await get("/auth/callback?code=out&state=forged", { Cookie: "halo_oauth=real.x" })).status).toBe(400);
    expect((await get("/auth/callback?code=out&state=x")).status).toBe(400);
    server.discord.users.set("ok", { id: "2", username: "friend", globalName: null });
    for (const target of ["//evil.example/", "https://evil.example/", "/\\evil.example", "evil"]) {
      expect((await login("ok", target)).headers.get("location"), target).toBe("/");
    }
  });

  it("asks for a login when there is no session", async () => {
    const response = await get("/auth/session");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ loginUrl: "/auth/login" });
  });

  it("has no development login unless configured", async () => {
    expect((await get("/auth/dev-login?name=x")).status).toBe(404);
  });
});

describe("rate limiting", () => {
  it("throttles the auth endpoints per client", async () => {
    await server.close();
    server = await start({ authRateLimitPerMinute: 3 });
    const statuses = [];
    for (let index = 0; index < 5; index++) statuses.push((await get("/auth/session")).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    expect((await get("/halo.html")).status).toBe(200);
  });
});

describe("development login", () => {
  it("issues a session without Discord when enabled", async () => {
    await server.close();
    server = await start({ devLogin: true, discord: null });
    const response = await get("/auth/dev-login?name=Alice&return=/halo.html%23room%3Dabc");
    expect(response.status).toBe(302);
    const session = await get("/auth/session", { Cookie: `halo_session=${cookies(response).halo_session}` });
    expect(await session.json()).toMatchObject({ user: { id: "dev:Alice", name: "Alice" } });
    const login = await get("/activity/auth/login?return=%2Factivity%2Fhalo.html%23room%3Dabc");
    expect(login.headers.get("location")).toBe("dev-login?return=%2Factivity%2Fhalo.html%23room%3Dabc");
  });
});

describe("the Discord Activity", () => {
  const launch = "/?frame_id=f1&instance_id=i-1-gc-2-3&platform=desktop";
  const activity = (body: unknown) => fetch(`${server.base}/auth/activity`, {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
  });

  it("gets Document-Isolation-Policy and Discord's script rules only on the launch document", async () => {
    const page = await get(launch);
    expect(page.status).toBe(200);
    expect(page.headers.get("document-isolation-policy")).toBe("isolate-and-require-corp");
    expect(page.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(page.headers.get("cross-origin-embedder-policy")).toBeNull();
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'self' 'unsafe-eval' blob:/);
    const html = await page.text();
    expect(html).toContain('<meta name="halo-activity" content="123">');
    expect(html).toMatch(/<script src="activity\.js\?v=[0-9a-f]{16}"><\/script>/);
    expect(html).not.toContain("halo-activity-dev");
    expect(html).not.toMatch(/<script>/);
    expect(html).not.toMatch(/\son[a-z]+=/);
    const plain = await get("/");
    expect(plain.headers.get("content-security-policy")).toBeNull();
    expect(plain.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(await plain.text()).toMatch(/<script src="halo-login\.js\?v=[0-9a-f]{16}"><\/script>/);
    const script = await get("/halo.js?frame_id=f1");
    expect(script.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("serves the site icon publicly with CORP, and links it from both pages", async () => {
    for (const [path, type] of [["/favicon.ico", "image/x-icon"], ["/icon-64.png", "image/png"],
        ["/apple-touch-icon.png", "image/png"]] as const) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toBe(type);
      expect(response.headers.get("cross-origin-resource-policy"), path).toBe("same-origin");
      expect((await response.arrayBuffer()).byteLength, path).toBeGreaterThan(100);
    }
    const ico = new Uint8Array(await (await get("/favicon.ico")).arrayBuffer());
    expect([...ico.slice(0, 6)]).toEqual([0, 0, 1, 0, 2, 0]);
    for (const page of ["/", launch]) {
      const html = await (await get(page)).text();
      expect(html, page).toMatch(/<link rel="icon" href="favicon\.ico\?v=[0-9a-f]{16}" sizes="32x32 64x64">/);
      expect(html, page).toMatch(/<link rel="apple-touch-icon" href="apple-touch-icon\.png\?v=[0-9a-f]{16}">/);
    }
    expect((await get("/icons/favicon.ico")).status).toBe(404);
  });

  it("serves the page's former inline scripts and handlers as same-origin files", async () => {
    expect(await (await get("/halo-shell-0.js")).text()).toBe("window.shellRan = true;");
    expect((await get("/halo-shell-1.js")).status).toBe(404);
    expect(await (await get("/halo-handlers.js")).text()).toContain("data-halo-on");
    expect(await (await get("/halo-login.js")).text()).toContain('fetch("auth/session"');
    expect(await (await get(launch)).text()).toContain("data-halo-oncontextmenu=event.preventDefault()");
  });

  it("bundles the Discord SDK into activity.js with its license", async () => {
    const response = await get("/activity.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/javascript/);
    const text = await response.text();
    expect(text).toMatch(/@discord\/embedded-app-sdk@\d/);
    expect(text).toContain("auth/activity");
    expect(text).toContain("halo-asset-version");
    expect(text).toContain("locateFile");
  }, 20_000);

  it("exchanges an SDK code without a redirect URI, keeping Discord's token on the server", async () => {
    server.discord.users.set("sdk", { id: "77", username: "arbiter", globalName: null });
    const response = await activity({ code: "sdk", instanceId: "i-1-gc-2-3" });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ user: { id: "77", name: "arbiter" } });
    expect(body).not.toHaveProperty("access_token");
    expect(JSON.stringify(body)).not.toContain("access-sdk");
    expect(server.discord.exchanges.at(-1)).toEqual({ code: "sdk", redirectUri: undefined });
    expect(cookies(response).halo_activity).toBe(body.token);
    expect(server.logs.find((entry) => entry.event === "login"))
      .toMatchObject({ via: "activity", user: "77", room: String(activityRoomId(SECRET, "i-1-gc-2-3")).slice(0, 8) });
    expect(JSON.stringify(server.logs)).not.toContain(String(body.token));
    expect(JSON.stringify(server.logs)).not.toContain("access-sdk");
    expect((await activity({})).status).toBe(400);
    expect((await activity({ code: "sdk", instanceId: "../x" })).status).toBe(400);
    server.discord.users.set("out", { id: "1", username: "stranger", globalName: null });
    server.discord.outsiders.add("out");
    expect((await activity({ code: "out" })).status).toBe(403);
  });

  it("maps an instance to one room derived with the server secret", async () => {
    server.discord.users.set("a", { id: "1", username: "a", globalName: null });
    server.discord.users.set("b", { id: "2", username: "b", globalName: null });
    const roomOf = async (code: string, instanceId: string) =>
      ((await (await activity({ code, instanceId })).json()) as { roomId: string }).roomId;
    const first = await roomOf("a", "i-1-gc-2-3");
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await roomOf("b", "i-1-gc-2-3")).toBe(first);
    expect(await roomOf("a", "i-9-gc-2-3")).not.toBe(first);
    expect(first).toBe(activityRoomId(SECRET, "i-1-gc-2-3"));
    expect(activityRoomId("another-secret-another-secret-12345", "i-1-gc-2-3")).not.toBe(first);
    expect(first).not.toContain("i-1");
  });

  it("uses a partitioned SameSite=None cookie on HTTPS and renews the cookie it was given", async () => {
    await server.close();
    server = await start({ publicOrigin: "https://halo.example" });
    server.discord.users.set("sdk", { id: "77", username: "arbiter", globalName: null });
    const response = await activity({ code: "sdk" });
    const line = response.headers.getSetCookie().find((value) => value.startsWith("halo_activity="))!;
    expect(line).toMatch(/HttpOnly/);
    expect(line).toMatch(/SameSite=None/);
    expect(line).toMatch(/Secure/);
    expect(line).toMatch(/Partitioned/);
    const renewed = await get("/auth/session", { Cookie: `halo_activity=${cookies(response).halo_activity}` });
    const renewedLine = renewed.headers.getSetCookie()[0]!;
    expect(renewedLine).toMatch(/^halo_activity=.*Partitioned/);
    const pageSession = await get("/auth/session", { Cookie: `halo_session=${token("5")}` });
    const pageLine = pageSession.headers.getSetCookie()[0]!;
    expect(pageLine).toMatch(/^halo_session=.*SameSite=Lax; Secure$/);
    expect(pageLine).not.toMatch(/Partitioned/);
    const map = await get("/assets/maps/bloodgulch.map", { Cookie: `halo_activity=${cookies(response).halo_activity}` });
    expect(map.status).toBe(200);
  });

  it("accepts development codes only under DEV_LOGIN", async () => {
    expect((await activity({ code: "dev:Alice" })).status).toBe(502);
    await server.close();
    server = await start({ devLogin: true, discord: null });
    const response = await activity({ code: "dev:Alice", instanceId: "local" });
    expect(await response.json()).toMatchObject({ user: { id: "dev:Alice", name: "Alice" } });
    expect(await (await get(launch)).text()).toContain('<meta name="halo-activity-dev" content="1">');
  });

  it("reports who is in a room to signed-in players", async () => {
    const room = "room-status-0001";
    expect((await get(`/v1/rooms/${room}`)).status).toBe(401);
    const signedIn = { Cookie: `halo_session=${token("9")}` };
    expect(await (await get(`/v1/rooms/${room}`, signedIn)).json()).toEqual({ host: null, players: 0 });
    const host = await join(server.base, room, "host", "user-h", "020000000001", { name: "Host Person" });
    expect(await (await get(`/v1/rooms/${room}`, signedIn)).json()).toEqual({ host: "Host Person", players: 1 });
    host.socket.close();
    expect((await get("/v1/rooms/bad", signedIn)).status).toBe(404);
  });

  it("accepts relay sockets from the application's discordsays.com origin", async () => {
    const client = open(server.base, "room-origin-0001", "host", "both", "https://123.discordsays.com");
    await new Promise<void>((resolve, reject) => {
      client.socket.once("open", () => resolve());
      client.socket.once("error", reject);
    });
    client.socket.close();
    const other = open(server.base, "room-origin-0001", "host", "both", "https://999.discordsays.com");
    await new Promise<void>((resolve) => other.socket.once("error", () => resolve()));
  });
});

describe("caching", () => {
  const launch = "/?frame_id=f1&instance_id=i-1-gc-2-3";
  const IMMUTABLE = "public, max-age=31536000, immutable";

  it("pins every asset the page loads to a content version that alone may be cached for good", async () => {
    for (const page of ["/", launch]) {
      const html = await (await get(page)).text();
      const app = /<meta name="halo-asset-version" content="([0-9a-f]{16})">/.exec(html)![1]!;
      const assets = [...html.matchAll(/(?:src|href)="([^"?]+)\?v=([0-9a-f]{16})"/g)].map((m) => [m[1]!, m[2]!]);
      const names = assets.map(([name]) => name);
      expect(names, page).toEqual(expect.arrayContaining(["halo-shell-0.js", "halo-handlers.js", "favicon.ico",
        "icon-64.png", "apple-touch-icon.png", page === "/" ? "halo-login.js" : "activity.js"]));
      expect(html, page).not.toMatch(/(?:src|href)="(?!https?:)[^"?]+\.(?:js|png|ico)"/);
      for (const [file, version] of [...assets, ["halo.js", app], ["halo.wasm", app]]) {
        const current = await get(`/${file}?v=${version}`);
        expect(current.status, file).toBe(200);
        expect(current.headers.get("cache-control"), file).toBe(IMMUTABLE);
        expect(current.headers.get("cross-origin-resource-policy"), file).toBe("same-origin");
        expect((await get(`/${file}`)).headers.get("cache-control"), file).toBe("no-cache");
        expect((await get(`/${file}?v=0000000000000000`)).headers.get("cache-control"), file).toBe("no-cache");
      }
    }
  }, 20_000);

  it("gives a new build a new version", async () => {
    await server.close();
    const files = fixtures();
    server = await start(files);
    const version = async () =>
      /<meta name="halo-asset-version" content="([0-9a-f]{16})">/.exec(await (await get("/")).text())![1];
    const before = await version();
    writeFileSync(joinPath(files.buildDir, "halo.js"), "// a later build\n");
    expect(await version()).not.toBe(before);
  });

  it("never stores pages, sessions, API answers or errors", async () => {
    const session = { Cookie: `halo_session=${token("9")}` };
    for (const [path, headers] of [["/", {}], [launch, {}], ["/healthz", {}], ["/auth/session", {}],
        ["/auth/session", session], ["/v1/rooms/abcdefghijklmnop", {}], ["/v1/rooms/abcdefghijklmnop", session],
        ["/missing.txt", {}], ["/assets/maps/bloodgulch.map", {}], ["/auth/login", {}]] as const) {
      const response = await get(path, headers);
      expect(response.headers.get("cache-control"), `${path} ${JSON.stringify(headers)}`).toBe("no-store");
    }
    const refused = await fetch(`${server.base}/auth/activity`, { method: "POST", body: "{}" });
    expect(refused.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps maps out of shared caches", async () => {
    const response = await get("/assets/maps/bloodgulch.map", { Cookie: `halo_session=${token("9")}`, Range: "bytes=0-3" });
    expect(response.status).toBe(206);
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("vary")).toBe("Cookie, Authorization");
    expect((await get("/assets/maps/bloodgulch.map")).headers.get("vary")).toBe("Cookie, Authorization");
  });
});

describe("measurement uploads", () => {
  const post = (body: string, cookie?: string) => fetch(`${server.base}/v1/netstats`, {
    method: "POST", body, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  });

  it("are off unless the server opts in", async () => {
    expect((await post("{}", `halo_session=${token("9")}`)).status).toBe(404);
    expect(await (await get("/")).text()).not.toContain("halo-netstats-upload");
  });

  it("log a signed-in player's windows, one every two seconds, small JSON objects only", async () => {
    await server.close();
    server = await start({ netstatsUpload: true });
    expect(await (await get("/")).text()).toContain('<meta name="halo-netstats-upload" content="1">');
    expect(await (await get("/?frame_id=f&instance_id=i")).text()).toContain("halo-netstats-upload");
    expect((await post("{}")).status).toBe(401);
    const cookie = `halo_session=${token("42", "Chief")}`;
    const window = { windowSeconds: 5, game: { ticksPerSecond: 30, ownCorrections: 0 } };
    const first = await post(JSON.stringify(window), cookie);
    expect(first.status).toBe(204);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(server.logs.find((entry) => entry.event === "netstats")).toEqual({ event: "netstats", user: "42", stats: window });
    expect((await post(JSON.stringify(window), cookie)).status).toBe(429);
    const other = `halo_session=${token("43")}`;
    expect((await post("[1, 2]", other)).status).toBe(400);
    const another = `halo_session=${token("44")}`;
    expect((await post("not json", another)).status).toBe(400);
    const big = `halo_session=${token("45")}`;
    expect((await post(JSON.stringify({ pad: "x".repeat(20_000) }), big)).status).toBe(413);
    expect(JSON.stringify(server.logs)).not.toContain(token("42", "Chief"));
  });
});

describe("client error reports", () => {
  const post = (body: string, cookie?: string) => fetch(`${server.base}/v1/client-errors`, {
    method: "POST", body, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  });

  it("log small JSON reports with the player's ID when there is one, a few at a time", async () => {
    const report = { kind: "startup", message: "boom" };
    expect((await post(JSON.stringify(report), `halo_session=${token("42")}`)).status).toBe(204);
    expect(server.logs.find((entry) => entry.event === "client-error")).toEqual({ event: "client-error", user: "42", error: report });
    expect((await post(JSON.stringify(report), `halo_session=${token("42")}`)).status).toBe(429);
    expect((await post(JSON.stringify(report))).status).toBe(204);
    expect(server.logs.filter((entry) => entry.event === "client-error").at(-1)).toMatchObject({ user: null });
    expect((await post("[]", `halo_session=${token("43")}`)).status).toBe(400);
    expect((await post(JSON.stringify({ message: "x".repeat(3000) }), `halo_session=${token("44")}`)).status).toBe(413);
  });
});
