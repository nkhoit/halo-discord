// @vitest-environment happy-dom
/// <reference lib="dom" />
/* A spectator (#52, client/hosted.js in a DOM): its menu first (Join or
   Spectate), then "Spectating <name>" with the mouse left free, clicks on
   the game picking whom to watch, Escape bringing the menu back, and Join
   adding its player (in the match, or from the lobby's bar). */
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const SCRIPT = readFileSync(new NodeURL("../client/hosted.js", import.meta.url), "utf8");

let status: Record<string, unknown> = { view: "joining-match", role: "guest", host: "Alice" };
const cycles: number[] = [];
let joins = 0;
let locks = 0;
const tick = () => new Promise((resolve) => setTimeout(resolve, 250));

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  expect(node, id).toBeTruthy();
  return node!;
}

function mouse(type: string, button: number) {
  const event = new MouseEvent(type, { button, bubbles: true, cancelable: true });
  byId("canvas").dispatchEvent(event);
  return event;
}

function escape() {
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true, cancelable: true }));
}

const visible = (id: string) => !byId(id).hidden;

beforeAll(() => {
  document.documentElement.classList.add("halo-hosted");
  document.body.innerHTML = '<main id="game-area" data-presented="true"><canvas id="canvas"></canvas></main>';
  (byId("canvas") as unknown as { requestPointerLock: () => void }).requestPointerLock = () => { locks++; };
  localStorage.clear();
  (window as unknown as Record<string, unknown>).HaloOnline = {
    status: () => status,
    spectateCycle: (direction: number) => { cycles.push(direction); return true; },
    spectatorJoin: () => {
      joins++;
      status = { ...status, spectatorJoining: true };
      return true;
    },
  };
  new Function(SCRIPT)();
});

describe("a spectator", () => {
  it("first sees its menu: Join or Spectate", async () => {
    await tick();
    status = { view: "spectating", role: "guest", host: "Alice", spectating: true, spectated: "Bravo",
      spectatorJoining: false };
    await tick();
    expect(visible("hosted-overlay")).toBe(true);
    expect(byId("hosted-overlay-title").textContent).toBe("Alice's match");
    expect(visible("hosted-spectate-join")).toBe(true);
    expect(byId("hosted-resume").textContent).toBe("Spectate");
    expect(visible("hosted-menu"), "no Halo menu for a spectator").toBe(false);
    expect(visible("hosted-spectate"), "the label waits under the menu").toBe(false);
  });

  it("watches with Spectate, without taking the mouse", async () => {
    byId("hosted-resume").click();
    await tick();
    expect(visible("hosted-overlay")).toBe(false);
    expect(visible("hosted-spectate")).toBe(true);
    expect(byId("hosted-spectate-name").textContent).toBe("Spectating Bravo");
    expect(locks).toBe(0);
  });

  it("picks whom to watch with clicks on the game, still without the mouse", () => {
    mouse("mousedown", 0);
    mouse("click", 0);
    mouse("mousedown", 2);
    expect(mouse("contextmenu", 2).defaultPrevented, "no context menu").toBe(true);
    mouse("mousedown", 1);
    expect(cycles).toEqual([1, -1]);
    expect(locks).toBe(0);
  });

  it("brings the menu back with Escape, and hides it again", async () => {
    escape();
    expect(visible("hosted-overlay")).toBe(true);
    expect(visible("hosted-spectate")).toBe(false);
    escape();
    expect(visible("hosted-overlay")).toBe(false);
  });

  it("joins the match with Join: its player, and the mouse for it", async () => {
    escape();
    byId("hosted-spectate-join").click();
    expect(joins).toBe(1);
    expect(locks, "Join takes the mouse, as Play does").toBe(1);
    expect(visible("hosted-overlay")).toBe(false);
    expect(byId("hosted-spectate-name").textContent).toBe("Joining the match…");
    status = { view: "match", role: "guest", host: "Alice", spectating: false };
    await tick();
    expect(visible("hosted-spectate")).toBe(false);
    mouse("mousedown", 0);
    expect(cycles, "a player's clicks are the game's").toEqual([1, -1]);
  });

  it("keeps watching into the next match without the menu again", async () => {
    status = { view: "spectating", role: "guest", host: "Alice", spectating: true, spectated: "Bravo" };
    await tick();
    escape();
    expect(visible("hosted-overlay")).toBe(true);
    byId("hosted-resume").click();
    status = { view: "postgame", role: "guest", host: "Alice", spectating: true };
    await tick();
    status = { view: "joined", role: "guest", host: "Alice", spectating: true };
    await tick();
    status = { view: "spectating", role: "guest", host: "Alice", spectating: true, spectated: "Bravo" };
    await tick();
    expect(visible("hosted-overlay"), "the lobby's bar offered Join").toBe(false);
    expect(byId("hosted-spectate-name").textContent).toBe("Spectating Bravo");
  });

  it("joins from the lobby's bar while it watches between matches", async () => {
    status = { view: "joined", role: "guest", host: "Alice", spectating: true, spectatorJoining: false };
    await tick();
    expect(visible("hosted-bar")).toBe(true);
    expect(byId("hosted-bar-text").textContent).toMatch(/^Spectating · /);
    expect(visible("hosted-bar-join")).toBe(true);
    byId("hosted-bar-join").click();
    expect(joins).toBe(2);
    expect(visible("hosted-bar-join"), "once").toBe(false);
    status = { view: "joined", role: "guest", host: "Alice", spectating: false };
    await tick();
    expect(visible("hosted-bar-join")).toBe(false);
    expect(byId("hosted-bar-text").textContent).not.toMatch(/Spectating/);
  });
});
