// @vitest-environment happy-dom
/// <reference lib="dom" />
/* The start-up report (client/hosted.js createBootRecorder): the stages the
   page's scripts queue make one report when the lobby or the room shows; a
   stage that does not advance for 30 s makes a "stalled" one (once a stage);
   a failure a "failed" one; leaving early an "unload" beacon. */
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const SCRIPT = readFileSync(new NodeURL("../client/hosted.js", import.meta.url), "utf8");

type Report = Record<string, unknown> & { kind: string; stages: Record<string, number> };
interface Recorder {
  event(entry: unknown[]): void;
  menu(): void;
  view(name: string, presented: boolean): void;
  line(level: string, text: string): void;
  hide(): void;
  check(): void;
  pagehide(): void;
}
type Factory = (environment: Record<string, unknown>) => Recorder;

const fetches: { url: string; body: string }[] = [];
const byId = (id: string) => document.getElementById(id)!;
let view = "booting";

beforeAll(() => {
  document.documentElement.classList.add("halo-hosted");
  document.head.innerHTML = '<meta name="halo-asset-version" content="0123abcd">';
  document.body.innerHTML = '<main id="game-area" data-presented="false"><canvas id="canvas"></canvas></main>';
  localStorage.clear();
  const page = window as unknown as Record<string, unknown>;
  page.fetch = async (url: string, init: { body: string }) => {
    fetches.push({ url, body: init.body });
    return { ok: true, status: 204 };
  };
  /* stages queued before the page's script runs (the shell's, the login's) */
  page.HaloBootEvents = [["page_loaded", 120, null], ["signed-in", 800, null]];
  page.HaloOnline = { status: () => ({ view }) };
  new Function(SCRIPT)();
});

function recorder() {
  let now = 0;
  const sent: { report: Report; beacon: boolean }[] = [];
  const factory = (window as unknown as { HaloHostedUI: { createBootRecorder: Factory } }).HaloHostedUI.createBootRecorder;
  const boot = factory({
    now: () => now,
    send: (report: Report, beacon: boolean) => sent.push({ report: JSON.parse(JSON.stringify(report)), beacon }),
    context: () => "activity",
    build: () => "0123abcd",
    resources: () => ({ wasm: { ms: 2600, cached: true, kb: 2826 } }),
    isolated: true,
  });
  return { boot, sent, at: (milliseconds: number) => { now = milliseconds; } };
}

describe("the start-up report", () => {
  it("sends one report, when the lobby or the room shows, with every stage", () => {
    const { boot, sent, at } = recorder();
    for (const entry of [["page_loaded", 100, null], ["sdk-ready", 900, null], ["signed-in", 1800, null],
        ["halo-js", 2500, null], ["storage", 2700, { mode: "opfs", lock: "granted" }], ["runtime_initialized", 4100, null],
        ["renderer_ready", 4300, null], ["transport_connected", 4400, null], ["game_presented", 5200, null],
        ["relay", 5600, null]]) {
      boot.event(entry);
    }
    boot.line("error", "halo-linux: web: built 12 programs ahead for ui in 196 ms");
    at(5800);
    boot.menu();
    boot.view("booting", false);
    boot.view("checking", true);
    boot.view("pick", false);
    expect(sent).toEqual([]);
    at(6100);
    boot.view("pick", true);
    boot.view("hosting", true);
    at(60_000);
    boot.check();
    boot.pagehide();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      beacon: false,
      report: {
        kind: "done", context: "activity", build: "0123abcd", elapsedMs: 6100, view: "pick",
        stages: { "page": 100, "sdk-ready": 900, "signed-in": 1800, "halo-js": 2500, "storage": 2700, "runtime": 4100,
          "renderer": 4300, "presented": 5200, "relay": 5600, "menu": 5800, "shown": 6100 },
        storage: { mode: "opfs", lock: "granted" }, shaders: { count: 12, ms: 196 },
        wasm: { ms: 2600, cached: true, kb: 2826 }, isolated: true, hidden: false,
      },
    });
  });

  it("sends a stalled report once for a stage that does not advance in 30 s, then an unload beacon", () => {
    const { boot, sent, at } = recorder();
    boot.event(["page_loaded", 100, null]);
    boot.event(["halo-js", 2500, null]);
    boot.line("log", "halo-linux: an ordinary line");
    boot.line("error", "halo-linux: something ordinary");
    boot.line("warn", "fetch failed for https://halo.example/assets/maps/x.map?token=secret from 'Chief'");
    at(32_400);
    boot.check();
    expect(sent).toEqual([]);
    at(32_600);
    boot.check();
    at(40_000);
    boot.check();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.report).toMatchObject({
      kind: "stalled", stuck: "halo-js", stuckMs: 30_100, elapsedMs: 32_600,
      stages: { "page": 100, "halo-js": 2500 }, lines: ["fetch failed for <url> from '…'"],
    });
    boot.event(["runtime_initialized", 41_000, null]);
    at(71_000);
    boot.check();
    expect(sent.map((entry) => [entry.report.kind, entry.report.stuck])).toEqual([["stalled", "halo-js"], ["stalled", "runtime"]]);
    boot.hide();
    at(75_000);
    boot.pagehide();
    boot.pagehide();
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ beacon: true, report: { kind: "unload", stuck: "runtime", stuckMs: 34_000, hidden: true } });
  });

  it("sends a failed report when the start gives up, and nothing after", () => {
    const { boot, sent, at } = recorder();
    boot.event(["sdk-ready", 900, null]);
    at(1000);
    boot.event(["failed", 1000, "not-isolated"]);
    boot.view("pick", true);
    at(60_000);
    boot.check();
    boot.pagehide();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.report).toMatchObject({ kind: "failed", reason: "not-isolated", stuck: "sdk-ready",
      stages: { "sdk-ready": 900, "failed": 1000 } });
    const shell = recorder();
    shell.boot.event(["runtime_error", 3000, "network"]);
    expect(shell.sent[0]!.report).toMatchObject({ kind: "failed", reason: "runtime-error" });
  });

  it("on the page, reads the queued stages and reports once the lobby shows", async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 250));
    await tick();
    expect(fetches.filter((call) => call.url === "v1/client-boot")).toEqual([]);
    view = "pick";
    await tick();
    expect(fetches.filter((call) => call.url === "v1/client-boot"), "not before the game shows").toEqual([]);
    byId("game-area").dataset.presented = "true";
    await tick();
    await tick();
    const reports = fetches.filter((call) => call.url === "v1/client-boot").map((call) => JSON.parse(call.body) as Report);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: "done", context: "page", build: "0123abcd", view: "pick" });
    expect(Object.keys(reports[0]!.stages)).toEqual(["page", "signed-in", "shown"]);
  });
});
