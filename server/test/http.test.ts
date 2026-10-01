import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Running, start, token } from "./harness.ts";

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
      expect((await login("ok", target)).headers.get("location"), target).toBe("/halo.html");
    }
  });

  it("asks for a login when there is no session", async () => {
    const response = await get("/auth/session");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ loginUrl: "/auth/login" });
  });

  it("exchanges an Embedded App SDK code for the Activity", async () => {
    server.discord.users.set("sdk", { id: "77", username: "arbiter", globalName: null });
    const response = await fetch(`${server.base}/auth/activity`, {
      method: "POST", body: JSON.stringify({ code: "sdk" }), headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ access_token: "access-sdk", user: { id: "77", name: "arbiter" } });
    expect(server.discord.exchanges.at(-1)).toEqual({ code: "sdk", redirectUri: undefined });
    const bad = await fetch(`${server.base}/auth/activity`, { method: "POST", body: "{}" });
    expect(bad.status).toBe(400);
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
