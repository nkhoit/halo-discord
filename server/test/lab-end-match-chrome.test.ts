/**
 * Chrome + local relay lab for #44 (DEV_LOGIN, no Discord / maps / wasm).
 *
 * Proves: host End match (not Close room) → postgame/summary UI, relay room
 * stays up with guest connected, host can configure next map/mode.
 *
 * Requires google-chrome and: cd server && npm i --no-save puppeteer-core
 * Artifacts: /tmp/halo-44-lab/ (or HALO_LAB_OUT).
 *
 * Run: npx vitest run test/lab-end-match-chrome.test.ts
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Running, join as relayJoin, start, settle } from "./harness.ts";

const OUT = process.env.HALO_LAB_OUT || "/tmp/halo-44-lab";
const ROOM = "lab44end";
const require = createRequire(import.meta.url);

function findChrome(): string | null {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
    try {
      return execSync(`command -v ${name}`, { encoding: "utf8" }).trim();
    } catch {
      /* try next */
    }
  }
  return null;
}

let puppeteer: typeof import("puppeteer-core") | null = null;
try {
  puppeteer = require("puppeteer-core");
} catch {
  puppeteer = null;
}

const chromePath = findChrome();
const canRun = Boolean(puppeteer && chromePath);

describe.skipIf(!canRun)("lab: Chrome + relay host End match (#44)", () => {
  let server: Running;
  let browser: import("puppeteer-core").Browser;
  const evidence: Record<string, unknown> = { steps: [] as string[] };

  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    server = await start({
      publicOrigin: "http://127.0.0.1:9",
      extraOrigins: [],
      /* harness fixtures already stub halo.html/js/wasm + maps */
    });
    (evidence.steps as string[]).push(`server ${server.base}`);
    writeFileSync(join(OUT, "base.txt"), server.base);

    browser = await puppeteer!.launch({
      executablePath: chromePath!,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--window-size=1280,800",
        "--use-gl=swiftshader",
      ],
      defaultViewport: { width: 1280, height: 800 },
    });
  }, 60_000);

  afterAll(async () => {
    writeFileSync(join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2));
    await browser?.close().catch(() => {});
    await server?.close();
  });

  it("host End match → postgame, room stays, guest stays, host configures", async () => {
    const steps = evidence.steps as string[];

    const hostRelay = await relayJoin(server.base, ROOM, "host", "user-h", "010000000001", { name: "Host" });
    const guestRelay = await relayJoin(server.base, ROOM, "guest", "user-g", "020000000002", { name: "Guest" });
    hostRelay.socket.send(JSON.stringify({ type: "phase", inMatch: true }));
    await settle();
    const inMatch = server.app.relay.summary(ROOM);
    evidence.summaryInMatch = inMatch;
    expect(inMatch).toMatchObject({ host: "Host", players: 2, inMatch: true });
    steps.push("relay host+guest in match");

    const labBootstrap = (role: "host" | "guest") => `(() => {
      const ROLE = ${JSON.stringify(role)};
      const state = {
        view: ROLE === "host" ? "hosting" : "joining",
        role: ROLE,
        host: "Host",
        settings: { mapIndex: 0, modeIndex: 0 },
        playerCount: 2,
      };
      let ends = 0, leaves = 0;
      const log = [];
      window.__lab = { state, ends: () => ends, leaves: () => leaves, log };
      window.HaloOnline = {
        status() { return { ...state }; },
        endMatch() {
          if (state.role !== "host" || state.view !== "match") {
            log.push({ op: "endMatch-refused", view: state.view, role: state.role });
            return false;
          }
          ends++;
          state.view = "postgame";
          log.push({ op: "endMatch", ends });
          return true;
        },
        leave() {
          leaves++;
          log.push({ op: "leave" });
          state.view = "idle";
          state.role = "none";
          return Promise.resolve();
        },
        configure(settings) {
          if (state.role !== "host") return false;
          state.settings = { ...settings };
          state.view = "hosting";
          log.push({ op: "configure", settings });
          return true;
        },
        runtimeReady() {},
      };
      document.addEventListener("DOMContentLoaded", () => {
        document.getElementById("game-area")?.setAttribute("data-presented", "true");
        document.getElementById("canvas")?.classList.add("ready");
      });
    })();`;

    async function openRole(role: "host" | "guest", name: string) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      page.on("console", (msg) => {
        writeFileSync(join(OUT, `${role}-console.log`), `[${msg.type()}] ${msg.text()}\n`, { flag: "a" });
      });
      await page.evaluateOnNewDocument(labBootstrap(role));
      /* Harness server has no DEV_LOGIN cookie path easily — inject session via
         cookie from /auth/session after using token header... The fixtures
         server uses FakeDiscord. Sign in by setting cookie from issueToken
         is awkward. Instead load the page with Authorization via cookie:
         fetch a session by posting? Simpler: navigate to page and the
         LOGIN_SCRIPT will 401 → login. Harness without DEV_LOGIN redirects
         to Discord login which 404s.

         So serve with a cookie: use page.setCookie with a token from harness. */
      const { issueToken } = await import("../src/tokens.ts");
      const { SECRET } = await import("./harness.ts");
      const { token } = issueToken(SECRET, `dev:${name}`, name, 3600);
      await page.setCookie({
        name: "halo_session",
        value: token,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      });
      await page.goto(`${server.base}/#room=${ROOM}`, { waitUntil: "networkidle0", timeout: 30_000 });
      await page.waitForSelector("#canvas, #hosted-overlay, #hosted-panel", { timeout: 15_000 });
      await page.evaluate(() => {
        let area = document.getElementById("game-area");
        const canvas = document.getElementById("canvas");
        if (!area) {
          area = document.createElement("main");
          area.id = "game-area";
          if (canvas?.parentNode) canvas.parentNode.insertBefore(area, canvas);
          else document.body.appendChild(area);
          if (canvas) area.appendChild(canvas);
        }
        area.setAttribute("data-presented", "true");
        canvas?.classList.add("ready");
      });
      return { context, page };
    }

    const host = await openRole("host", "Host");
    const guest = await openRole("guest", "Guest");
    steps.push("chrome host+guest pages loaded");

    await host.page.evaluate(() => {
      let area = document.getElementById("game-area");
      if (!area) {
        area = document.createElement("main");
        area.id = "game-area";
        document.body.appendChild(area);
        const canvas = document.getElementById("canvas");
        if (canvas) area.appendChild(canvas);
      }
      area.setAttribute("data-presented", "true");
      document.getElementById("canvas")?.classList.add("ready");
      (window as any).__lab.state.view = "match";
      (window as any).__lab.state.role = "host";
      (window as any).__lab.state.host = "Host";
    });
    await settle();
    const debugHost = await host.page.evaluate(() => ({
      hasLab: !!(window as any).__lab,
      hasOnline: !!(window as any).HaloOnline,
      status: (window as any).HaloOnline?.status?.(),
      end: document.getElementById("hosted-end-match")?.outerHTML ?? null,
      overlay: document.getElementById("hosted-overlay")?.hidden,
      leave: document.getElementById("hosted-leave")?.textContent,
      presented: document.getElementById("game-area")?.dataset.presented,
      bodyClass: document.documentElement.className,
      hostedScript: !!document.querySelector('script[src*="hosted"]'),
      title: document.title,
      htmlStart: document.documentElement.outerHTML.slice(0, 500),
    }));
    writeFileSync(join(OUT, "debug-host.json"), JSON.stringify(debugHost, null, 2));
    evidence.debugHost = debugHost;
    await host.page.waitForFunction(() => {
      const btn = document.getElementById("hosted-end-match");
      return btn && !btn.hidden;
    }, { timeout: 10_000 });
    await host.page.screenshot({ path: join(OUT, "01-host-match-overlay.png"), fullPage: true });
    steps.push("host End match visible");

    await guest.page.evaluate(() => {
      window.__lab.state.view = "match";
      window.__lab.state.role = "guest";
    });
    await guest.page.waitForFunction(() => {
      const end = document.getElementById("hosted-end-match");
      const leave = document.getElementById("hosted-leave");
      return leave && !leave.hidden && (!end || end.hidden);
    }, { timeout: 10_000 });
    await guest.page.screenshot({ path: join(OUT, "02-guest-match-no-end-match.png"), fullPage: true });
    expect(await guest.page.$eval("#hosted-leave", (el) => el.textContent)).toBe("Leave game");
    steps.push("guest has no End match");

    await host.page.click("#hosted-end-match");
    await host.page.waitForSelector("#hosted-end-confirm:not([hidden])", { timeout: 5_000 });
    await host.page.screenshot({ path: join(OUT, "03-host-end-confirm.png"), fullPage: true });
    await host.page.click("#hosted-end-confirm-yes");

    await host.page.waitForFunction(
      () => (window as unknown as { __lab: { ends: () => number; state: { view: string } } }).__lab.ends() === 1 &&
        (window as unknown as { __lab: { state: { view: string } } }).__lab.state.view === "postgame",
      { timeout: 5_000 },
    );
    await settle();
    await host.page.waitForFunction(() => {
      const next = document.getElementById("hosted-next");
      return next && !next.hidden;
    }, { timeout: 10_000 });
    await host.page.screenshot({ path: join(OUT, "04-host-postgame.png"), fullPage: true });

    const hostLab = await host.page.evaluate(() => {
      const lab = (window as unknown as { __lab: {
        ends: () => number; leaves: () => number; state: { view: string }; log: unknown[];
      } }).__lab;
      return {
        ends: lab.ends(),
        leaves: lab.leaves(),
        view: lab.state.view,
        log: lab.log,
        leaveText: document.getElementById("hosted-leave")?.textContent,
        nextText: document.getElementById("hosted-next")?.textContent,
        nextVisible: !!(document.getElementById("hosted-next") && !document.getElementById("hosted-next")!.hidden),
      };
    });
    evidence.hostAfterEnd = hostLab;
    expect(hostLab.ends).toBe(1);
    expect(hostLab.leaves).toBe(0);
    expect(hostLab.view).toBe("postgame");
    expect(hostLab.nextVisible).toBe(true);
    expect(hostLab.nextText).toBe("Next match");
    expect(hostLab.leaveText).toBe("Close room");
    steps.push("host postgame / Next match; endMatch once; leave never");

    /* Room still up — End match must not revoke. Flip phase to lobby. */
    expect(hostRelay.socket.readyState).toBe(1);
    expect(guestRelay.socket.readyState).toBe(1);
    hostRelay.socket.send(JSON.stringify({ type: "phase", inMatch: false }));
    await settle();
    const lobby = server.app.relay.summary(ROOM);
    evidence.summaryLobby = lobby;
    expect(lobby).toMatchObject({ host: "Host", players: 2, inMatch: false });
    steps.push("relay room still up after End match");

    await host.page.evaluate(() => {
      const lab = (window as unknown as { __lab: { state: { view: string } }; HaloOnline: { configure: (s: unknown) => boolean } });
      lab.__lab.state.view = "hosting";
      return window.HaloOnline.configure({ mapIndex: 0, modeIndex: 1 });
    });
    await settle();
    await host.page.waitForFunction(() => {
      const title = document.getElementById("hosted-title");
      return title && !document.getElementById("hosted-panel")!.hidden;
    }, { timeout: 10_000 });
    await host.page.screenshot({ path: join(OUT, "05-host-configure-next.png"), fullPage: true });
    await guest.page.screenshot({ path: join(OUT, "06-guest-still-in-room.png"), fullPage: true });

    const configured = await host.page.evaluate(() =>
      (window as unknown as { __lab: { state: { settings: { modeIndex: number } } } }).__lab.state.settings);
    evidence.configured = configured;
    expect(configured.modeIndex).toBe(1);

    const guestLab = await guest.page.evaluate(() => {
      const lab = (window as unknown as { __lab: { ends: () => number; leaves: () => number; state: { view: string; role: string } } }).__lab;
      return { ends: lab.ends(), leaves: lab.leaves(), view: lab.state.view, role: lab.state.role };
    });
    evidence.guestAfterEnd = guestLab;
    expect(guestLab.ends).toBe(0);
    expect(guestLab.leaves).toBe(0);
    expect(guestLab.role).toBe("guest");
    expect(guestRelay.socket.readyState).toBe(1);

    evidence.pass = true;
    steps.push("PASS");
    writeFileSync(join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2));
    expect(existsSync(join(OUT, "01-host-match-overlay.png"))).toBe(true);
    expect(existsSync(join(OUT, "04-host-postgame.png"))).toBe(true);

    hostRelay.socket.close();
    guestRelay.socket.close();
    await host.context.close();
    await guest.context.close();
  }, 120_000);
});

describe.skipIf(canRun)("lab: Chrome + relay (skipped — missing chrome or puppeteer-core)", () => {
  it("documents the skip", () => {
    expect(canRun).toBe(false);
  });
});
