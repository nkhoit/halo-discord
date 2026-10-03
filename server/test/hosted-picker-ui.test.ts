// @vitest-environment happy-dom
/// <reference lib="dom" />
/* The picker's pictures (client/hosted.js in a DOM): they need the session
   cookie, so none is requested before the picker shows (in the Activity,
   that is before activity.js has signed in); a failed one gets one more
   try, then only its label remains. */
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = readFileSync(new NodeURL("../client/hosted.js", import.meta.url), "utf8");

let status: Record<string, unknown> = { view: "booting" };
const pictures = () => [...document.querySelectorAll<HTMLImageElement>("#hosted-picker img")];
const tick = () => new Promise((resolve) => setTimeout(resolve, 250));

/* The picture retry's timer, run by hand. */
const retries: (() => void)[] = [];
const realSetTimeout = window.setTimeout;
function captureRetries() {
  (window as unknown as { setTimeout: unknown }).setTimeout = (callback: () => void, milliseconds?: number) => {
    if (milliseconds === 3000) {
      retries.push(callback);
      return 0;
    }
    return realSetTimeout(callback, milliseconds);
  };
}
afterEach(() => { window.setTimeout = realSetTimeout; });

beforeAll(() => {
  document.documentElement.classList.add("halo-hosted");
  document.body.innerHTML = '<main id="game-area" data-presented="true"><canvas id="canvas"></canvas></main>';
  localStorage.clear();
  (window as unknown as Record<string, unknown>).HaloOnline = { status: () => status };
  new Function(SCRIPT)();
});

describe("the picker's pictures", () => {
  it("are not requested before the picker shows", async () => {
    expect(pictures().length).toBe(document.querySelectorAll(".hosted-map, .hosted-mode").length);
    expect(pictures().length).toBeGreaterThan(0);
    for (const view of ["booting", "checking", "joining"]) {
      status = { view };
      await tick();
      expect(pictures().filter((image) => image.hasAttribute("src")), view).toEqual([]);
    }
  });

  it("load when the picker first shows", async () => {
    status = { view: "pick", settings: { mapIndex: 0, modeIndex: 0 } };
    await tick();
    expect(document.getElementById("hosted-picker")!.hidden).toBe(false);
    const sources = pictures().map((image) => image.getAttribute("src"));
    expect(sources).toContain("game-ui/maps/blood-gulch.png");
    expect(sources).toContain("game-ui/modes/slayer.png");
    expect(sources.every((source) => /^game-ui\/(maps|modes)\/[a-z0-9-]+\.png$/.test(source ?? ""))).toBe(true);
  });

  it("try once more after a failure, and stay when that works", () => {
    captureRetries();
    const image = pictures()[0]!;
    const source = image.getAttribute("src");
    image.dispatchEvent(new Event("error"));
    expect(image.isConnected, "kept for the retry").toBe(true);
    expect(retries).toHaveLength(1);
    image.removeAttribute("src");
    retries.shift()!();
    expect(image.getAttribute("src")).toBe(source);
    image.dispatchEvent(new Event("load"));
    expect(image.isConnected).toBe(true);
  });

  it("leave only the label after a second failure", () => {
    captureRetries();
    const image = pictures()[1]!;
    const card = image.parentElement!;
    image.dispatchEvent(new Event("error"));
    retries.shift()!();
    expect(() => image.dispatchEvent(new Event("error"))).not.toThrow();
    expect(image.isConnected).toBe(false);
    expect(retries, "no third try").toHaveLength(0);
    expect(card.querySelector(".hosted-card-label")?.textContent).toBeTruthy();
    expect(card.querySelector("img")).toBeNull();
  });
});
