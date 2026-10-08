/* activity.js as built for the page, run against a stand-in for the browser
   with the development SDK (which mimics the real SDK's console capture and
   Discord's captureLog validation). */

import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { activityBundle } from "../src/bundle.ts";

interface Fetch { url: string; body?: string }

async function launch() {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const fetches: Fetch[] = [];
  const appended: { src?: string }[] = [];
  const info = (..._args: unknown[]) => {};
  const fakeConsole = { log() {}, warn() {}, debug() {}, error() {}, info };
  const metas: Record<string, { content: string }> = {
    'meta[name="halo-activity"]': { content: "123" },
    'meta[name="halo-activity-dev"]': { content: "1" },
    'meta[name="halo-public-origin"]': { content: "https://halo.example" },
    'meta[name="halo-asset-version"]': { content: "abc" },
  };
  const element = () => ({ style: {}, append() {}, setAttribute() {}, addEventListener() {} });
  const context: Record<string, unknown> = {
    console: fakeConsole,
    performance: { now: () => 7 },
    location: new URL("http://localhost:8090/?frame_id=f&instance_id=i-1&dev_user=Alice"),
    URL, URLSearchParams, setTimeout, clearTimeout, Promise, Error, JSON, Object, Array, Boolean, String, Date,
    crossOriginIsolated: true,
    fetch: async (url: string, init?: { body?: string }) => {
      fetches.push({ url, body: init?.body });
      if (url === "auth/activity") {
        return { ok: true, status: 200, json: async () => ({ roomId: "room", user: { id: "dev:Alice", name: "Alice" }, token: "t" }) };
      }
      return { ok: true, status: 204, json: async () => ({}) };
    },
    document: {
      readyState: "complete",
      querySelector: (selector: string) => metas[selector] ?? null,
      getElementById: () => null,
      createElement: () => element(),
      head: { append: (child: { src?: string }) => appended.push(child) },
      body: { append() {} },
      addEventListener() {},
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      (listeners[type] ??= []).push(listener);
    },
    open: () => null,
  };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.runInNewContext(await activityBundle(), context);
  for (let index = 0; index < 20 && !appended.length; index++) await new Promise((resolve) => setTimeout(resolve, 5));
  return { context, listeners, fetches, appended, fakeConsole, info };
}

describe("the Activity start-up script", () => {
  it("starts the game without letting the SDK capture the console", async () => {
    const { context, appended, fakeConsole, info } = await launch();
    expect(appended.map((child) => child.src)).toEqual(["halo.js?v=abc"]);
    expect((context.HaloActivity as { roomId: string }).roomId).toBe("room");
    /* the start-up report's stages, for hosted.js's boot recorder */
    expect((context.HaloBootEvents as [string, number, unknown][]).map((event) => event[0]))
      .toEqual(["sdk-ready", "signed-in"]);
    /* With console capture on, the stand-in (like the SDK) wraps console.info
       and Discord rejects long lines, which became a fatal start-up error. */
    expect(fakeConsole.info).toBe(info);
  }, 20_000);

  it("keeps a failed Discord command from failing the start, and reports errors to the server", async () => {
    const { listeners, fetches } = await launch();
    const [guard] = listeners.unhandledrejection!;
    const calls: string[] = [];
    const event = (reason: unknown) => ({
      reason,
      preventDefault: () => calls.push("preventDefault"),
      stopImmediatePropagation: () => calls.push("stopImmediatePropagation"),
    });
    guard!(event({ code: 4000, message: 'child "message" fails because ["message" length must be ...]' }));
    expect(calls).toEqual(["preventDefault", "stopImmediatePropagation"]);
    calls.length = 0;
    guard!(event(new Error("a real failure")));
    expect(calls).toEqual([]);
    const reports = fetches.filter((call) => call.url === "v1/client-errors").map((call) => JSON.parse(call.body!));
    expect(reports.map((report) => report.kind)).toEqual(["discord-command", "unhandledrejection"]);
    expect(reports[1].message).toBe("a real failure");
  }, 20_000);
});
